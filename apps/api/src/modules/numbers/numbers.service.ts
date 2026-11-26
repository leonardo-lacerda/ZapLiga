import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { MAIN_WAXUM_NODE, WaxumClient, waxumNodes } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { EntitlementService } from '../billing/entitlement.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { CrmEventsService, CrmLineEventType } from '../crm-events/crm-events.service';
import { STEADY_ONLINE_SECONDS, slotOnlineSql } from '../egress/pc-network';
import { LINE_RETIRED_AFTER_LOSSES, YOUNG_LINE_DAYS } from '../dialer/dialer.rules';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

// A line WhatsApp took away LINE_RETIRED_AFTER_LOSSES times does not pair again.
function assertNotRetired(number: any) {
  if (Number(number.removal_count ?? 0) >= LINE_RETIRED_AFTER_LOSSES) throw new BadRequestException(`Linha aposentada: o WhatsApp já tirou este número ${number.removal_count} vezes. Use outro número.`);
  return number;
}

export type CreateNumberInput = { label?: string; phone?: string; maxConcurrentCalls?: number; cooldownSeconds?: number; maxCallsPerWindow?: number; callWindowSeconds?: number };
export type UpdateNumberInput = { label?: string; maxConcurrentCalls?: number; cooldownSeconds?: number; maxCallsPerWindow?: number; callWindowSeconds?: number; verificationOnly?: boolean };

/**
 * WhatsApp line management shared by the panel (NumbersController) and the CRM
 * integration API. `actorUserId` is null when an integration key acts.
 */
// Seconds to wait for a moved line to log in on its new Waxum.
const MOVE_CONNECT_CHECKS = 20;
// WhatsApp removes a device that calls minutes after being linked, so a line created here stays
// out of the dialer for this long after its last pairing QR or code. Counts from the last one shown.
const PAIRING_CALL_BLOCK_HOURS = 24;
// Sent from the line to a team phone right before its canary call. Varied so the lines do not
// all send the same text.
const CANARY_MESSAGES = [
  'Oi! Tudo bem? Te ligo daqui a pouquinho, pode atender?',
  'Olá, tudo certo? Vou te ligar rapidinho em seguida.',
  'Oi, bom dia! Posso te ligar agora rapidinho?',
  'Opa, tudo bem? Já já te ligo, pode ser?',
];
// Lines never go out through the VPS: WhatsApp reads a datacenter IP as a ban signal.
const NO_VPS_MESSAGE = 'Linhas não podem sair pela VPS. Escolha o PC de um atendente.';
const NO_PC_MESSAGE = 'Nenhum PC online para conectar a linha. Ligue o PC de um atendente em Admin → Saídas de internet.';

@Injectable()
export class NumbersService {
  private readonly logger = new Logger(NumbersService.name);
  private readonly qrRequests = new Map<string, Promise<any>>();
  private readonly waxumCreateCooldownKey = 'zapcall:waxum:create-session:cooldown';
  private readonly waxumCreateLockKey = 'zapcall:waxum:create-session:lock';

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient, private readonly audit: AuditService, private readonly redis: RedisService, private readonly entitlement: EntitlementService, private readonly planLimits: PlanLimitsService, @Optional() private readonly crmEvents?: CrmEventsService) {}

  // Connected CRMs mirror the tenant's lines; reporting is best-effort.
  private emitCrmLine(tenantId: string, numberId: string, eventType: CrmLineEventType) {
    void this.crmEvents?.recordLine(tenantId, numberId, eventType).catch((error) => this.logger.warn(`CRM event ${eventType} not recorded for line ${numberId}: ${String((error as Error)?.message ?? error).slice(0, 200)}`));
  }

  /**
   * The line is born on the Waxum that will hold it, so WhatsApp sees the device's very first
   * login from that exit (docs/estudo-bloqueio-numero-geelark.md). `node` pins it (registration
   * on a chosen PC); otherwise the PC the distribution would pick. Never the VPS.
   */
  async create(tenantId: string, actorUserId: string | null, body: CreateNumberInput, node?: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId ?? undefined);
    const label = String(body.label ?? '').trim();
    if (!label) throw new BadRequestException('label é obrigatório');
    let createdSessionId: string | undefined;
    let persisted = false;
    try {
      // A PC that only just came online still takes a new line: never the VPS, and no wait.
      const waxumNode = node ?? await this.pickPcSlot() ?? await this.pickPcSlot(false);
      if (!waxumNode) throw new BadRequestException(NO_PC_MESSAGE);
      const session = await this.createWaxumSession(label, waxumNode);
      createdSessionId = session.id;
      // A new line's cooldown defaults to the tenant's own "Proteção entre
      // chamadas" (Configurações do discador) instead of a hardcoded value,
      // so that setting stays the single place operators configure it.
      const dialerDefaults = await this.db.query('SELECT default_number_cooldown_seconds FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
      const defaultCooldownSeconds = Number(dialerDefaults.rows[0]?.default_number_cooldown_seconds ?? 60);
      const result = await this.db.transaction(async (client) => {
        // Keep the advisory lock, count and INSERT on one transaction.
        await this.planLimits.assertCanAddNumbers(tenantId, client, 1);
        return client.query(`INSERT INTO whatsapp_numbers (id,tenant_id,label,phone,waxum_session_id,max_concurrent_calls,cooldown_seconds,max_calls_per_window,call_window_seconds,waxum_node,block_calls_after_pairing,canary_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'pending') RETURNING *`, [randomUUID(), tenantId, label, digits(body.phone) || null, session.id, Number(body.maxConcurrentCalls ?? 1), Number(body.cooldownSeconds ?? defaultCooldownSeconds), Number(body.maxCallsPerWindow ?? 3), Number(body.callWindowSeconds ?? 180), waxumNode]);
      });
      persisted = true;
      await this.audit.record({ actorUserId, tenantId, action: 'number.created', entityType: 'whatsapp_number', entityId: result.rows[0].id });
      this.emitCrmLine(tenantId, result.rows[0].id, 'number.created');
      return result.rows[0];
    } catch (error) {
      if (createdSessionId && !persisted) await this.waxum.deleteSession(createdSessionId).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(`Não foi possível criar a sessão Waxum: ${String(error)}`);
    }
  }

  async list(tenantId: string, limit = 100, offset = 0) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const cacheKey = `zapcall:tenant:${tenantId}:numbers:${safeLimit}:${safeOffset}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) { try { return JSON.parse(cached); } catch { /* recompute corrupt cache */ } }
    const total = await this.db.query("SELECT count(*)::int AS total FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId]);
    // calls_today: what the daily cap of a young line counts (dialer.rules lineUnderDailyCapSql).
    // reconnects_24h: logins in the last day; each one is a fresh look by WhatsApp.
    const items = await this.db.query(`
      SELECT n.*,
        (SELECT count(*)::int FROM calls c, tenants tz WHERE tz.id = n.tenant_id AND c.tenant_id = n.tenant_id AND c.number_id = n.id
          AND c.created_at >= date_trunc('day', now() AT TIME ZONE tz.timezone) AT TIME ZONE tz.timezone) AS calls_today,
        (SELECT count(*)::int FROM number_status_history h WHERE h.tenant_id = n.tenant_id AND h.number_id = n.id
          AND h.changed_at > now() - interval '24 hours' AND lower(h.to_status) IN ('connected', 'online', 'ready', 'authenticated')) AS reconnects_24h,
        (n.last_paired_at IS NOT NULL AND n.last_paired_at > now() - make_interval(days => $4)) AS young,
        -- Bytes through the line's own proxy (proxy slots only, migration 079): today and this month.
        (SELECT sum(u.rx_bytes + u.tx_bytes)::bigint FROM egress_proxy_usage u WHERE u.number_id = n.id AND u.day = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS network_today_bytes,
        (SELECT sum(u.rx_bytes + u.tx_bytes)::bigint FROM egress_proxy_usage u WHERE u.number_id = n.id AND u.day >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date) AS network_month_bytes
      FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.status <> 'removed' ORDER BY n.created_at DESC LIMIT $2 OFFSET $3
    `, [tenantId, safeLimit, safeOffset, YOUNG_LINE_DAYS]);
    const response = { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'PX', 1500).catch(() => undefined);
    return response;
  }

  async remove(tenantId: string, actorUserId: string | null, id: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId ?? undefined);
    const number = await this.find(id, tenantId);
    const active = await this.db.query("SELECT 1 FROM calls WHERE number_id = $1 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1", [id]);
    if (active.rows[0]) throw new BadRequestException('Nao e possivel remover um numero durante uma chamada');

    try {
      await this.waxum.deleteSession(number.waxum_session_id);
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw new BadRequestException(`Nao foi possivel remover a sessao Waxum: ${String(error)}`);
    }

    await this.db.query("UPDATE whatsapp_numbers SET status = 'removed' WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    await this.audit.record({ actorUserId, tenantId, action: 'number.removed', entityType: 'whatsapp_number', entityId: id });
    this.emitCrmLine(tenantId, id, 'number.removed');
    return { ok: true, id, archived: true };
  }

  async qr(tenantId: string, id: string) {
    const requestKey = `${tenantId}:${id}`;
    const current = this.qrRequests.get(requestKey);
    if (current) return current;
    const request = this.loadQr(id, tenantId).finally(() => this.qrRequests.delete(requestKey));
    this.qrRequests.set(requestKey, request);
    return request;
  }

  async reconnect(tenantId: string, actorUserId: string | null, id: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId ?? undefined);
    let number = await this.find(id, tenantId);
    try {
      const result = await this.waxum.reconnect(number.waxum_session_id);
      await this.audit.record({ actorUserId, tenantId, action: 'number.reconnect_requested', entityType: 'whatsapp_number', entityId: id });
      return result;
    } catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      const result = await this.waxum.reconnect(number.waxum_session_id);
      await this.audit.record({ actorUserId, tenantId, action: 'number.reconnect_requested', entityType: 'whatsapp_number', entityId: id });
      return result;
    }
  }

  async pairCode(tenantId: string, actorUserId: string, id: string, phone: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) throw new BadRequestException('Informe o telefone com DDI e DDD, ex.: 5527999999999');
    let number = await this.pairOnHealthySlot(assertNotRetired(await this.find(id, tenantId)));
    let result: { code: string; timeout_seconds: number };
    try { result = await this.waxum.pairCode(number.waxum_session_id, digits); }
    catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      if (statusCode === 409) throw new BadRequestException('Este número já está conectado ao WhatsApp');
      if (statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      result = await this.waxum.pairCode(number.waxum_session_id, digits);
    }
    await this.markPairing(number);
    await this.audit.record({ actorUserId, tenantId, action: 'number.pair_code_requested', entityType: 'whatsapp_number', entityId: id });
    return { code: result.code, timeout_seconds: result.timeout_seconds };
  }

  async updateSettings(tenantId: string, actorUserId: string | null, id: string, body: UpdateNumberInput) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId ?? undefined);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET max_concurrent_calls = COALESCE($1,max_concurrent_calls), cooldown_seconds = COALESCE($2,cooldown_seconds), max_calls_per_window = COALESCE($3,max_calls_per_window), call_window_seconds = COALESCE($4,call_window_seconds), label = COALESCE($5,label), verification_only = COALESCE($8,verification_only) WHERE id = $6 AND tenant_id = $7 AND status <> 'removed' RETURNING *`, [body.maxConcurrentCalls == null ? null : Number(body.maxConcurrentCalls), body.cooldownSeconds == null ? null : Number(body.cooldownSeconds), body.maxCallsPerWindow == null ? null : Number(body.maxCallsPerWindow), body.callWindowSeconds == null ? null : Number(body.callWindowSeconds), body.label ? String(body.label) : null, id, tenantId, typeof body.verificationOnly === 'boolean' ? body.verificationOnly : null]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    await this.audit.record({ actorUserId, tenantId, action: 'number.settings_changed', entityType: 'whatsapp_number', entityId: id, ...(typeof body.verificationOnly === 'boolean' ? { metadata: { verificationOnly: body.verificationOnly } } : {}) });
    this.emitCrmLine(tenantId, id, 'number.updated');
    return result.rows[0];
  }

  private async find(id: string, tenantId: string) {
    const result = await this.db.query('SELECT * FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    return result.rows[0];
  }

  /**
   * Moves the line to another Waxum (another internet exit). The WhatsApp
   * session cannot be carried over, so the line gets a new one there and has
   * to scan the QR again; the old session is deleted.
   */
  /**
   * Moves a line to another Waxum (another internet exit) without a new QR: every
   * Waxum mounts the same session storage, so the source lets go of the session
   * without logging out and the target opens the same device keys. The session id
   * stays the same. `actorUserId` is null when the egress pool moves the line.
   */
  async moveToWaxumNode(tenantId: string, actorUserId: string | null, id: string, node: string) {
    if (!waxumNodes().has(node)) throw new BadRequestException(`Saída "${node}" não existe`);
    if (node === MAIN_WAXUM_NODE) throw new BadRequestException(NO_VPS_MESSAGE);
    const lockKey = `zapcall:global:lock:number-move:${id}`;
    const lockToken = randomUUID();
    if (!await this.redis.acquireLock(lockKey, lockToken, 90_000)) throw new HttpException('Esta linha já está trocando de saída', HttpStatus.CONFLICT);
    try {
      const number = await this.find(id, tenantId);
      if (number.status === 'removed') throw new NotFoundException('Número não encontrado');
      if (number.waxum_node === node) return number;
      const target = await this.db.query(`SELECT ${slotOnlineSql('$1::text')} AS online`, [node]);
      if (!target.rows[0]?.online) throw new BadRequestException('Essa saída (PC ou proxy) não está online. Confira em Admin → Saídas de internet.');
      // Out of the dialer first, then check for calls: none can start halfway through the move.
      await this.db.query("UPDATE whatsapp_numbers SET status = 'reconnecting' WHERE id = $1", [id]);
      const active = await this.db.query("SELECT 1 FROM calls WHERE number_id = $1 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1", [id]);
      if (active.rows[0]) {
        await this.db.query('UPDATE whatsapp_numbers SET status = $2 WHERE id = $1', [id, number.status]);
        throw new BadRequestException('Nao e possivel trocar a saida de um numero durante uma chamada');
      }

      const sessionId = number.waxum_session_id;
      await this.waxum.releaseSession(sessionId, number.waxum_node).catch((error: Error & { statusCode?: number }) => {
        // A 4xx means the source no longer holds a live client. Unreachable means its
        // container is down, so nothing is live there either.
        if (error.statusCode && error.statusCode >= 500) throw error;
        if (!error.statusCode) this.logger.warn(`Waxum ${number.waxum_node} unreachable while releasing line ${id}: ${String(error.message).slice(0, 200)}`);
      });
      try {
        await this.waxum.adoptSession(sessionId, number.label, node);
      } catch (error) {
        await this.waxum.adoptSession(sessionId, number.label, number.waxum_node).catch(() => undefined);
        await this.db.query("UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1", [id]);
        throw error;
      }
      await this.db.query('UPDATE whatsapp_numbers SET waxum_node = $2 WHERE id = $1', [id, node]);

      let status = normalizeWaxumStatus(await this.waxum.statusOn(sessionId, node).catch(() => ({})));
      for (let attempt = 0; !status.connected && attempt < MOVE_CONNECT_CHECKS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = normalizeWaxumStatus(await this.waxum.statusOn(sessionId, node).catch(() => ({})));
      }
      const result = await this.db.query('UPDATE whatsapp_numbers SET status = $2, phone = COALESCE($3, phone) WHERE id = $1 RETURNING *', [id, status.status, status.phone]);
      await this.audit.record({ actorUserId, tenantId, action: 'number.waxum_node_changed', entityType: 'whatsapp_number', entityId: id, metadata: { from: number.waxum_node, to: node, connected: status.connected } });
      this.emitCrmLine(tenantId, id, 'number.updated');
      return result.rows[0];
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  /**
   * Pairing needs a slot that reaches WhatsApp. A line created on a PC that has since stopped
   * passing internet (its route is no longer `pc`) would wait for a QR that never comes, so a
   * session that never logged in starts over on the slot the distribution picks now. A session
   * that did log in keeps its session; the egress pool moves it. A line on the VPS never pairs
   * there: WhatsApp would see the new device's first login from a datacenter IP.
   */
  private async pairOnHealthySlot(number: any) {
    const online = await this.db.query(`SELECT ${slotOnlineSql('$1::text')} AS online`, [number.waxum_node]);
    if (online.rows[0]?.online) return number;
    const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id).catch(() => ({})));
    if (status.connected || status.phone) return number;
    const node = await this.pickPcSlot();
    if (!node) throw new BadRequestException(NO_PC_MESSAGE);
    const session = await this.createWaxumSession(number.label, node);
    await this.waxum.deleteSession(number.waxum_session_id).catch((error) => this.logger.warn(`Old session of line ${number.id} not deleted on ${number.waxum_node}: ${String((error as Error)?.message ?? error).slice(0, 200)}`));
    const result = await this.db.query(`UPDATE whatsapp_numbers SET waxum_node = $1, waxum_session_id = $2, status = 'disconnected' WHERE id = $3 AND tenant_id = $4 RETURNING *`, [node, session.id, number.id, number.tenant_id]);
    this.logger.log(`Line ${number.id} pairing moved from ${number.waxum_node} (PC without internet) to ${node}`);
    return result.rows[0];
  }

  private async replaceMissingSession(number: any) {
    const session = await this.createWaxumSession(number.label, number.waxum_node);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET waxum_session_id = $1, status = 'disconnected' WHERE id = $2 AND tenant_id = $3 RETURNING *`, [session.id, number.id, number.tenant_id]);
    return result.rows[0];
  }

  /**
   * The PC slot a new line goes to, by the egress pool's own rule (EgressPoolService): the
   * online PC with the fewest lines below "Números por PC". `steadyOnly = false` also takes a PC
   * that has not yet been online for STEADY_ONLINE_SECONDS.
   */
  private async pickPcSlot(steadyOnly = true): Promise<string | undefined> {
    const result = await this.db.query(`
      SELECT p.slot FROM egress_pcs p LEFT JOIN egress_settings s ON true
      CROSS JOIN LATERAL (SELECT count(*)::int AS lines FROM whatsapp_numbers n WHERE n.waxum_node = p.slot AND n.status <> 'removed' AND n.phone IS NOT NULL) l
      WHERE p.slot IS NOT NULL AND p.route = 'pc' AND p.route_reported_at > now() - interval '1 minute'
        AND (NOT $2::boolean OR p.online_since < now() - make_interval(secs => $1)) AND l.lines < COALESCE(s.max_numbers_per_pc, 5)
      ORDER BY l.lines, p.created_at LIMIT 1
    `, [STEADY_ONLINE_SECONDS, steadyOnly]);
    return result.rows[0]?.slot as string | undefined;
  }

  /**
   * Session creation is a Waxum control-plane operation. Serialize it across
   * both API instances and persist a 429 cooldown in Redis so browser retries
   * cannot create a penalty storm after a restart.
   */
  private async createWaxumSession(label: string, node: string) {
    const cooldown = await this.redis.client.ttl(this.waxumCreateCooldownKey).catch(() => -1);
    if (cooldown > 0) throw this.waxumCooldownError(cooldown);

    const token = randomUUID();
    const locked = await this.redis.acquireLock(this.waxumCreateLockKey, token, 30_000).catch(() => false);
    if (!locked) throw new HttpException('Outra criação de sessão está em andamento. Aguarde alguns segundos.', HttpStatus.TOO_MANY_REQUESTS);

    try {
      const lockCooldown = await this.redis.client.ttl(this.waxumCreateCooldownKey).catch(() => -1);
      if (lockCooldown > 0) throw this.waxumCooldownError(lockCooldown);
      return await this.waxum.createSession(label, node);
    } catch (error) {
      // A cooldown generated by this service already contains the exact
      // remaining Redis TTL; do not reinterpret it as a fresh Waxum 429.
      if (error instanceof HttpException) throw error;
      const typed = error as Error & { statusCode?: number; retryAfterSeconds?: number };
      if (typed.statusCode === 429 || /\b429\b|too many requests/i.test(String(typed))) {
        const retryAfter = this.parseWaxumWaitSeconds(typed);
        await this.redis.client.set(this.waxumCreateCooldownKey, '1', 'EX', retryAfter).catch(() => undefined);
        throw this.waxumCooldownError(retryAfter);
      }
      throw error;
    } finally {
      await this.redis.releaseLock(this.waxumCreateLockKey, token).catch(() => undefined);
    }
  }

  private parseWaxumWaitSeconds(error: Error & { retryAfterSeconds?: number }) {
    const headerValue = Number(error.retryAfterSeconds);
    const messageValue = Number(String(error).match(/wait for\s+(\d+)\s*s?/i)?.[1]);
    const seconds = Number.isFinite(headerValue) && headerValue > 0 ? headerValue : messageValue;
    return Math.min(86_400, Math.max(1, Math.floor(Number.isFinite(seconds) && seconds > 0 ? seconds : 180)));
  }

  private waxumCooldownError(seconds: number) {
    return new HttpException(`O Waxum está temporariamente limitando novas sessões. Aguarde ${seconds} segundos antes de tentar novamente.`, HttpStatus.TOO_MANY_REQUESTS);
  }

  private async loadQr(id: string, tenantId: string) {
    let number = await this.pairOnHealthySlot(assertNotRetired(await this.find(id, tenantId)));
    let payload: any;
    try { payload = await this.loadQrFromSession(number.waxum_session_id); }
    catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      payload = await this.loadQrFromSession(number.waxum_session_id);
    }
    const status = await this.refreshNumberStatus(number);
    if (status.connected) return { ...payload, status: 'connected', phone_number: status.phone };
    await this.markPairing(number);
    return payload;
  }

  /**
   * A pairing QR or code was shown: WhatsApp will judge the new device on its first call, so the
   * line waits for its canary (migration 077) and counts as young again. Lines created with the
   * block (migration 076) also stay 24 h without calls; a longer quarantine, e.g. the 72 h of a
   * PC registration, is kept instead of shortened.
   */
  private async markPairing(number: any) {
    await this.db.query(`
      UPDATE whatsapp_numbers SET last_paired_at = now(), canary_status = 'pending', loss_reason = NULL, loss_at = NULL,
        flagged_until = CASE WHEN block_calls_after_pairing THEN GREATEST(flagged_until, now() + make_interval(hours => $1)) ELSE flagged_until END
      WHERE id = $2 AND tenant_id = $3
    `, [PAIRING_CALL_BLOCK_HOURS, number.id, number.tenant_id]);
  }

  /**
   * A manager releases a line for lead calls without the team-phone call (e.g. after warming it up
   * by hand): the canary counts as passed and the pairing block or canary rest is lifted. Recorded
   * as a human `canary_passed` health event and audited.
   */
  async passCanary(tenantId: string, actorUserId: string, id: string, reason: string | null) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET canary_status = 'passed', flagged_until = NULL WHERE id = $1 AND tenant_id = $2 AND status <> 'removed' RETURNING *`, [id, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    const metadata = { manual: true, reason };
    await this.db.query(`INSERT INTO number_health_events (tenant_id, number_id, event_type, actor_type, metadata, occurred_at) VALUES ($1, $2, 'canary_passed', 'human', $3::jsonb, now())`, [tenantId, id, JSON.stringify(metadata)]);
    await this.audit.record({ actorUserId, tenantId, action: 'number.canary_passed', entityType: 'whatsapp_number', entityId: id, metadata });
    this.emitCrmLine(tenantId, id, 'number.updated');
    return result.rows[0];
  }

  /**
   * First step of the canary (DialerService.manualCallWithInput with `canary`): the line texts a
   * team phone, so the call that follows is not a cold first contact. Returns that phone, which
   * the canary call must dial; the team phone least used by past canaries goes first.
   */
  async sendCanaryMessage(tenantId: string, actorUserId: string, id: string) {
    await this.entitlement.assertAction(tenantId, 'write', actorUserId);
    const number = assertNotRetired(await this.find(id, tenantId));
    if (number.canary_status === 'passed') throw new BadRequestException('Esta linha já passou pelo canário');
    if (!['connected', 'online', 'ready', 'authenticated'].includes(String(number.status).toLowerCase())) throw new BadRequestException('A linha não está conectada');
    if (number.flagged_until && new Date(number.flagged_until).getTime() > Date.now()) throw new BadRequestException(`A linha está bloqueada até ${new Date(number.flagged_until).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    const phone = (await this.db.query(`
      SELECT p.phone FROM dialer_settings ds CROSS JOIN LATERAL unnest(ds.canary_phones) AS p(phone)
      WHERE ds.tenant_id = $1
      ORDER BY (SELECT count(*) FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.tenant_id = $1 AND c.canary AND l.phone = p.phone), p.phone
      LIMIT 1
    `, [tenantId])).rows[0]?.phone as string | undefined;
    if (!phone) throw new BadRequestException('Cadastre os celulares da equipe para o canário em Configurações → Operação.');
    await this.waxum.sendText(number.waxum_session_id, phone, CANARY_MESSAGES[Math.floor(Math.random() * CANARY_MESSAGES.length)]);
    await this.audit.record({ actorUserId, tenantId, action: 'number.canary_message_sent', entityType: 'whatsapp_number', entityId: id, metadata: { phone } });
    return { phone };
  }

  private async refreshNumberStatus(number: any) {
    const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
    await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3 AND tenant_id = $4', [status.status, status.phone, number.id, number.tenant_id]);
    if (status.status !== number.status) this.emitCrmLine(number.tenant_id, number.id, 'number.status_changed');
    return status;
  }

  private async loadQrFromSession(sessionId: string) {
    // Waxum only shows a QR while the session is pairing. A session WhatsApp logged out, or one whose socket
    // dropped, answers the QR request with "disconnected" and an empty list forever, so /connect starts the
    // pairing first; new sessions answer 503 instead and are handled below.
    if (await this.sessionIsIdle(sessionId)) await this.waxum.reconnect(sessionId);
    try {
      return await this.waitForQr(sessionId);
    } catch (error) {
      const typedError = error as Error & { statusCode?: number };
      // Newly-created sessions need /connect before Waxum can expose a QR.
      // Opening the QR in the panel should perform that transition for the operator.
      if (typedError.statusCode !== 503) throw error;
      await this.waxum.reconnect(sessionId);
      return this.waitForQr(sessionId);
    }
  }

  // Not logged in and without an open socket: nothing is pairing, so no QR will ever come
  private async sessionIsIdle(sessionId: string) {
    try {
      const status = await this.waxum.getStatus(sessionId);
      return !status?.is_logged_in && status?.socket_alive === false;
    } catch {
      return false;
    }
  }

  private async waitForQr(sessionId: string) {
    let last: any = { qr_codes: [], timeout_seconds: 60, status: 'waiting_for_qr' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        last = await this.waxum.getQr(sessionId);
        if ((Array.isArray(last?.qr_codes) && last.qr_codes.length > 0) || (typeof last?.qr === 'string' && last.qr.length > 0)) return last;
      } catch (error) { if ((error as Error & { statusCode?: number }).statusCode !== 429) throw error; }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return last;
  }
}
