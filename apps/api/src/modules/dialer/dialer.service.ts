import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import WebSocket, { RawData } from 'ws';
import { DatabaseService } from '../../database/database.service';
import { legacyTenantId } from '../../database/tenant-context';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { SdrGateway } from '../sdrs/sdr.gateway';

type CallResource = {
  tenantId: string;
  token: string;
  numberId: string;
  leadId: string;
  sdrId: string;
  media?: WebSocket;
  browser?: WebSocket;
  mediaActive: boolean;
  mediaOpen?: boolean;
  answerSignalReceived?: boolean;
  answerAbort?: AbortController;
  answerWatcherStarted?: boolean;
  sdrNotified?: boolean;
  waxumCallId?: string;
  answerEventLogged?: boolean;
  browserAudioLogged?: boolean;
  ringTimeout?: NodeJS.Timeout;
  browserMessageHandler?: (data: RawData, isBinary: boolean) => void;
  browserCloseHandler?: () => void;
  browserErrorHandler?: () => void;
  finishing?: boolean;
  rateLimitBackoffSeconds?: number;
  callPlacedAt?: number;
  receivedAnyFrame?: boolean;
};

@Injectable()
export class DialerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DialerService.name);
  private timer?: NodeJS.Timeout;
  private readonly ticking = new Set<string>();
  private readonly lastStatusSyncAt = new Map<string, number>();
  private readonly active = new Map<string, CallResource>();
  private readonly finishingCalls = new Set<string>();
  private readonly logs: any[] = [];
  // Consecutive "instant failure" count per WhatsApp line (no media frames, no
  // answer, closed in <FLAG_FAST_FAIL_MS). Repeated instant failures are the
  // signature of a WhatsApp reachout timelock (463 MissingTcToken).
  private readonly lineFailures = new Map<string, number>();
  private readonly FLAG_FAILURE_THRESHOLD = 2;
  private readonly FLAG_FAST_FAIL_MS = 5000;
  private readonly flagQuarantineHours = Math.max(1, Number(process.env.WHATSAPP_FLAG_HOURS) || 6);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly waxum: WaxumClient,
    @Inject(forwardRef(() => SdrGateway)) private readonly gateway: SdrGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tickAllTenants(), 1000);
    void this.resetStaleSdrPresence().then(() => this.recoverInterruptedCalls()).then(() => this.tickAllTenants());
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const resource of this.active.values()) {
      resource.answerAbort?.abort();
      resource.media?.close();
    }
  }

  async getSettings(tenantId = legacyTenantId()) {
    await this.db.query('INSERT INTO dialer_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const result = await this.db.query('SELECT * FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
    return result.rows[0];
  }

  getLogs(tenantId = legacyTenantId()) { return this.logs.filter((entry) => entry.tenantId === tenantId).slice(0, 100); }

  private normalizePhone(value: unknown) { return String(value ?? '').replace(/\D/g, ''); }

  // Resolve the VoIP recipient for a phone. WhatsApp calls require the callee's
  // LID (not the phone-number JID) to derive media keys. Cold numbers have no
  // LID in the store, so we trigger a usync (`contacts/check`, silent for the
  // callee) to learn it, then read and cache it. The LID is a stable identity,
  // so caching it in Redis means we pay the usync cost once per number instead
  // of on every dial — which is what previously triggered the 429 storms.
  private async resolveRecipient(sessionId: string, phone: string): Promise<string> {
    if (phone.includes('@lid')) return phone;
    const pn = this.normalizePhone(phone);
    if (!pn) throw new Error('lid_unavailable');
    const cacheKey = `zapcall:lid:${pn}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) return `${cached}@lid`;
    const contact = await this.waxum.checkContact(sessionId, pn);
    if (!contact) throw new Error('lid_unavailable');
    if (!contact.isRegistered) throw new Error('not_on_whatsapp');
    let lid = await this.waxum.getStoredLid(sessionId, contact.jid);
    if (!lid) {
      // The usync that learns the LID can land just after check returns; retry
      // the store read once after a short delay before giving up.
      await new Promise((resolve) => setTimeout(resolve, 400));
      lid = await this.waxum.getStoredLid(sessionId, contact.jid);
    }
    if (!lid) throw new Error('lid_unavailable');
    await this.redis.client.set(cacheKey, lid, 'EX', 60 * 60 * 24 * 30).catch(() => undefined);
    return `${lid}@lid`;
  }

  async getSdrState(sdrId: string, tenantId = legacyTenantId()) {
    const result = await this.db.query(`
      SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
        p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
        c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
        c.connected_at AS pause_call_started_at
      FROM sdrs s
      LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
      LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
      LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
      WHERE s.tenant_id = $1 AND s.id = $2
    `, [tenantId, sdrId]);
    return result.rows[0] ?? null;
  }

  async setAvailability(sdrId: string, available: boolean, tenantId = legacyTenantId()) {
    const sdr = await this.getSdrState(sdrId, tenantId);
    if (!sdr) throw new Error('SDR não encontrado');
    if (available && sdr.current_pause_id) throw new Error('Finalize o pós-atendimento antes de ficar disponível');
    if (available) {
      const active = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND sdr_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, sdrId]);
      if (active.rows[0]) throw new Error('O SDR ainda está em uma chamada');
    }
    const state = available ? 'available' : 'offline';
    await this.db.query('UPDATE sdrs SET available = $1, state = $2 WHERE tenant_id = $3 AND id = $4', [available, state, tenantId, sdrId]);
    if (available) {
      // A disponibilidade do SDR habilita a operação automática da empresa.
      // O tick ainda valida SDRs, números e pastas ativas antes de discar.
      const settings = await this.getSettings(tenantId);
      if (!settings.running) {
        await this.db.query('UPDATE dialer_settings SET running = true WHERE tenant_id = $1', [tenantId]);
        this.log('Discador iniciado automaticamente por disponibilidade do SDR', 'info', undefined, tenantId);
      }
      await this.tick(tenantId);
    }
    this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state, available }, tenantId);
    return this.getSdrState(sdrId, tenantId);
  }

  async finishPause(sdrId: string, pauseId: string, input: { callResult?: string; pipelineStage?: string; notes?: string }, tenantId = legacyTenantId()) {
    const callResult = String(input.callResult ?? '').trim();
    const pipelineStage = String(input.pipelineStage ?? '').trim();
    const notes = String(input.notes ?? '').trim();
    if (!callResult || !pipelineStage || !notes) throw new Error('Resultado, etapa da tubulação e anotação são obrigatórios');
    return this.db.transaction(async (client) => {
      const pauseResult = await client.query(`SELECT p.*, c.lead_id FROM sdr_pauses p LEFT JOIN calls c ON c.tenant_id = p.tenant_id AND c.id = p.call_id WHERE p.tenant_id = $1 AND p.id = $2 AND p.sdr_id = $3 FOR UPDATE OF p`, [tenantId, pauseId, sdrId]);
      const pause = pauseResult.rows[0];
      if (!pause) throw new Error('Pausa não encontrada');
      if (pause.ended_at) throw new Error('Esta pausa já foi encerrada');
      const endedAt = new Date();
      await client.query(`UPDATE sdr_pauses SET ended_at = $1, duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($1 - started_at))::int) WHERE tenant_id = $2 AND id = $3`, [endedAt, tenantId, pauseId]);
      if (pause.call_id) {
        await client.query(`UPDATE calls SET call_result = $1, pipeline_stage = $2, notes = $3, wrap_up_completed_at = $4 WHERE tenant_id = $5 AND id = $6`, [callResult, pipelineStage, notes, endedAt, tenantId, pause.call_id]);
        const previousStage = await client.query(`SELECT pipeline_stage FROM leads WHERE tenant_id = $1 AND id = $2`, [tenantId, pause.lead_id]);
        await client.query(`UPDATE leads SET pipeline_stage = $1 WHERE tenant_id = $2 AND id = $3`, [pipelineStage, tenantId, pause.lead_id]);
        const fromStage = previousStage.rows[0]?.pipeline_stage ?? null;
        if (fromStage !== pipelineStage) {
          await client.query(`INSERT INTO lead_stage_history (id, tenant_id, lead_id, from_stage, to_stage, source, call_id) VALUES ($1, $2, $3, $4, $5, 'wrap_up', $6)`, [randomUUID(), tenantId, pause.lead_id, fromStage, pipelineStage, pause.call_id]);
        }
      }
      await client.query(`UPDATE sdrs SET available = true, state = 'available', current_pause_id = NULL WHERE tenant_id = $1 AND id = $2 AND current_pause_id = $3`, [tenantId, sdrId, pauseId]);
      return { id: pauseId, ended_at: endedAt.toISOString(), duration_seconds: Math.max(0, Math.floor((endedAt.getTime() - new Date(pause.started_at).getTime()) / 1000)), call_result: callResult, pipeline_stage: pipelineStage, notes };
    }).then((result) => {
      this.gateway.sendToSdr(sdrId, { type: 'pause_finished', pauseId, state: 'available' });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state: 'available', available: true }, tenantId);
      return result;
    });
  }

  private log(message: string, level: 'info' | 'warning' | 'error' = 'info', callId?: string, tenantId = legacyTenantId()) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), level, message, callId, tenantId };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    this.gateway.broadcast({ type: 'dialer_log', log: entry }, tenantId);
  }

  async updateSettings(input: Record<string, unknown>, tenantId = legacyTenantId()) {
    const allowed = [
      'global_max_concurrent_calls', 'max_attempts_per_lead', 'retry_delay_minutes',
      'ring_timeout_seconds', 'default_number_cooldown_seconds',
    ];
    const values: unknown[] = [];
    const sets: string[] = [];
    for (const key of allowed) {
      if (input[key] !== undefined) {
        const value = Math.max(0, Number(input[key]));
        if (!Number.isFinite(value)) continue;
        values.push(Math.floor(value));
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length) await this.db.query(`UPDATE dialer_settings SET ${sets.join(', ')} WHERE tenant_id = $${values.length + 1}`, [...values, tenantId]);
    return this.getSettings(tenantId);
  }

  async start(tenantId = legacyTenantId()) {
    await this.db.query('UPDATE dialer_settings SET running = true WHERE tenant_id = $1', [tenantId]);
    this.log('Discador iniciado', 'info', undefined, tenantId);
    await this.tick(tenantId);
    return this.getStatus(tenantId);
  }

  async pause(tenantId = legacyTenantId()) {
    await this.db.query('UPDATE dialer_settings SET running = false WHERE tenant_id = $1', [tenantId]);
    this.log('Discador pausado', 'info', undefined, tenantId);
    return this.getStatus(tenantId);
  }

  private async defaultFolderId(tenantId: string) {
    const result = await this.db.query(`SELECT id FROM lead_folders WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC LIMIT 1`, [tenantId]);
    if (!result.rows[0]) throw new Error('Nenhuma pasta de leads foi configurada');
    return result.rows[0].id as string;
  }

  async manualCall(leadId: string, tenantId = legacyTenantId()) {
    const settings = await this.getSettings(tenantId);
    const [sdrs, numbers, leads] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `, [tenantId]),
      // Manual calls intentionally bypass the number cooldown for the MVP.
      // Redis still enforces the global and per-number concurrent limits.
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
      this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.id = $2 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $3`, [tenantId, leadId, settings.max_attempts_per_lead]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    const lead = leads.rows[0];
    if (!lead) throw new Error('Este lead não está elegível para uma chamada manual');
    if (!sdr) throw new Error('Nenhum SDR conectado e disponível');
    if (!numbers.rows.length) throw new Error('Nenhum número WhatsApp conectado e fora do cooldown');
    const number = numbers.rows.find((row: any) => this.normalizePhone(row.phone) !== this.normalizePhone(lead.phone));
    if (!number) throw new Error('O número de destino é a própria linha de WhatsApp conectada. Ligue para um número diferente.');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      tenantId, token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id,
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estão ocupados; tente novamente em instantes');
    return this.startReservedCall(sdr, number, lead, settings, token, 'manual', tenantId);
  }

  async manualCallWithInput(input: { leadId?: string; phone?: string; name?: string }, tenantId = legacyTenantId(), sdrUserId?: string) {
    const settings = await this.getSettings(tenantId);
    let lead: any;
    const leadId = String(input.leadId ?? '').trim();
    if (leadId) {
      const result = await this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.id = $2 AND f.is_active = true AND l.do_not_call = false`, [tenantId, leadId]);
      lead = result.rows[0];
      if (lead) {
        const activeCall = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, lead.id]);
        if (activeCall.rows[0]) lead = undefined;
      }
    } else {
      const phone = String(input.phone ?? '').replace(/\D/g, '');
      if (!phone) throw new Error('Informe um telefone valido');
      const existing = await this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.phone = $2 AND f.is_active = true LIMIT 1`, [tenantId, phone]);
      if (existing.rows[0]) {
        lead = existing.rows[0];
        const activeCall = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, lead.id]);
        // A manual call is an explicit override of queue eligibility. It may
        // redial a previously completed/failed lead, but never a blocked lead
        // or one that already has an active call.
        if (lead.do_not_call || activeCall.rows[0]) lead = undefined;
      } else {
        lead = await this.db.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
          const [tenant, count] = await Promise.all([
            client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]),
            client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]),
          ]);
          if (Number(count.rows[0]?.count ?? 0) >= Number(tenant.rows[0]?.max_leads ?? 100000)) throw new Error('O limite de leads desta empresa foi atingido');
          const folderId = await this.defaultFolderId(tenantId);
          const folder = await client.query('SELECT is_active FROM lead_folders WHERE tenant_id = $1 AND id = $2', [tenantId, folderId]);
          if (!folder.rows[0]?.is_active) throw new Error('Nenhuma pasta de leads ativa');
          return (await client.query('INSERT INTO leads (id, tenant_id, folder_id, name, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *', [randomUUID(), tenantId, folderId, String(input.name ?? '').trim() || 'Ligacao manual', phone])).rows[0];
        });
      }
    }
    if (!lead) throw new Error('Este contato nao esta elegivel para uma chamada manual');

    const [sdrs, numbers] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND ($2::text IS NULL OR s.user_id = $2)
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `, [tenantId, sdrUserId ?? null]),
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    if (!sdr) throw new Error('Nenhum SDR conectado e disponivel');
    if (!numbers.rows.length) throw new Error('Nenhum numero WhatsApp conectado');
    // WhatsApp cannot place a call to the line's own number (self-call closes
    // the media socket immediately), so never pair a lead with its own line.
    const number = numbers.rows.find((row: any) => this.normalizePhone(row.phone) !== this.normalizePhone(lead.phone));
    if (!number) throw new Error('O numero de destino e a propria linha de WhatsApp conectada. Ligue para um numero diferente.');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      tenantId, token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id,
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estao ocupados; tente novamente em instantes');
    return { ...(await this.startReservedCall(sdr, number, lead, settings, token, 'manual', tenantId)), leadId: lead.id };
  }

  async getStatus(tenantId = legacyTenantId(), from?: string, to?: string) {
    const settings = await this.getSettings(tenantId);
    const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : new Date().toISOString();
    const startDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const start = startDate.toISOString();
    const counts = await this.db.query(`
      SELECT status, count(*)::int AS count FROM calls
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 GROUP BY status
    `, [tenantId, start, end]);
    const answered = await this.db.query(`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered
      FROM calls WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
    `, [tenantId, start, end]);
    const [available, leads, numberDetails, queueSummary, queuePreview, activeCalls, sdrDetails, folderSummary] = await Promise.all([
      this.db.query(`
        SELECT count(*)::int AS count FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
      `, [tenantId]),
      this.db.query(`SELECT l.status, count(*)::int AS count FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND f.is_active = true GROUP BY l.status`, [tenantId]),
      this.db.query(`
        SELECT n.id, n.label, n.status, n.max_concurrent_calls, n.cooldown_seconds,
          n.last_call_ended_at, n.flagged_until,
          (n.flagged_until IS NOT NULL AND n.flagged_until > now()) AS flagged,
          CASE WHEN n.flagged_until IS NULL OR n.flagged_until <= now() THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (n.flagged_until - now())))::int)
          END AS flagged_remaining_seconds,
          COUNT(c.id)::int AS active_calls,
          CASE WHEN n.last_call_ended_at IS NULL THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM ((n.last_call_ended_at + n.cooldown_seconds * interval '1 second') - now())))::int)
          END AS cooldown_remaining_seconds
        FROM whatsapp_numbers n
        LEFT JOIN calls c ON c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')
        WHERE n.tenant_id = $1 AND n.status <> 'removed'
        GROUP BY n.id
        ORDER BY n.created_at DESC
      `, [tenantId]),
      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE next_eligible_at <= now())::int AS ready,
          COUNT(*) FILTER (WHERE next_eligible_at > now())::int AS waiting
        FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
        WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT l.id, l.name, l.phone, l.status, l.attempts, l.next_eligible_at, f.name AS folder_name,
          ROW_NUMBER() OVER (ORDER BY l.next_eligible_at ASC, l.created_at ASC)::int AS queue_position
        FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
        WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
        ORDER BY l.next_eligible_at ASC, l.created_at ASC
        LIMIT 12
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT c.id, c.status, c.attempt_number, c.created_at, c.started_at, c.connected_at,
          GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(c.connected_at, c.started_at, c.created_at)))::int) AS elapsed_seconds,
          l.name AS lead_name, l.phone AS lead_phone, n.label AS number_label, s.name AS sdr_name
        FROM calls c
        JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        JOIN whatsapp_numbers n ON n.id = c.number_id
        JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id
        WHERE c.tenant_id = $1 AND c.status IN ('reserved', 'dialing', 'media_active')
        ORDER BY c.created_at ASC
      `, [tenantId]),
      this.db.query(`
        SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
          p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
          c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
          c.connected_at AS pause_call_started_at,
          CASE WHEN p.started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - p.started_at))::int) END AS pause_elapsed_seconds
        FROM sdrs s
        LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
        LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
        LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        WHERE s.tenant_id = $1
        ORDER BY s.name
      `, [tenantId]),
      this.db.query(`
        SELECT f.id AS folder_id, f.name, f.is_active,
          COUNT(l.id)::int AS lead_count,
          COUNT(l.id) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < ds.max_attempts_per_lead AND l.next_eligible_at <= now())::int AS ready_count,
          COUNT(l.id) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < ds.max_attempts_per_lead)::int AS queue_count
        FROM lead_folders f
        LEFT JOIN dialer_settings ds ON ds.tenant_id = f.tenant_id
        LEFT JOIN leads l ON l.tenant_id = f.tenant_id AND l.folder_id = f.id
        WHERE f.tenant_id = $1
        GROUP BY f.id, f.name, f.is_active, ds.max_attempts_per_lead, f.sort_order, f.created_at
        ORDER BY f.sort_order ASC, f.created_at ASC
      `, [tenantId]),
    ]);
    const queue = queueSummary.rows[0] ?? { total: 0, ready: 0, waiting: 0 };
    const nextLead = queuePreview.rows[0] ?? null;
    const connectedNumbers = numberDetails.rows.filter((row: any) => ['connected', 'online', 'ready', 'authenticated'].includes(String(row.status).toLowerCase()));
    const dialableNumbers = connectedNumbers.filter((row: any) => !row.flagged);
    const readyNumbers = dialableNumbers.filter((row: any) => Number(row.cooldown_remaining_seconds) === 0);
    const activeFolders = folderSummary.rows.filter((row: any) => row.is_active);
    let nextAction = 'Pronto para discar';
    if (!settings.running) nextAction = 'Discador pausado';
    else if (!activeFolders.length) nextAction = 'Nenhuma pasta ativa';
    else if (!Number(queue.total)) nextAction = 'Fila vazia';
    else if (!Number(available.rows[0].count)) nextAction = 'Aguardando SDR disponível';
    else if (!connectedNumbers.length) nextAction = 'Aguardando número WhatsApp conectado';
    else if (!dialableNumbers.length) nextAction = 'Linhas pausadas pelo limite do WhatsApp';
    else if (!readyNumbers.length) nextAction = 'Aguardando cooldown dos números';
    else if (!Number(queue.ready)) nextAction = 'Aguardando horário da próxima tentativa';
    return {
      running: settings.running,
      settings,
      active_calls: Array.from(this.active.values()).filter((resource) => resource.tenantId === tenantId).length,
      available_sdrs: available.rows[0].count,
      call_counts: Object.fromEntries(counts.rows.map((row: any) => [row.status, row.count])),
      answered: answered.rows[0].answered,
      answer_rate: answered.rows[0].total ? Math.round((answered.rows[0].answered / answered.rows[0].total) * 100) : 0,
      lead_counts: Object.fromEntries(leads.rows.map((row: any) => [row.status, row.count])),
      sdrs: sdrDetails.rows,
      post_call_sdrs: sdrDetails.rows.filter((row: any) => row.state === 'post_call'),
      queue: { total: Number(queue.total), ready: Number(queue.ready), waiting: Number(queue.waiting), preview: queuePreview.rows },
      numbers: numberDetails.rows,
      active_calls_detail: activeCalls.rows,
      next_action: nextAction,
      next_lead: nextLead,
      active_folder_count: activeFolders.length,
      active_folder_ids: activeFolders.map((row: any) => row.folder_id),
      queued_leads_active_folders: Number(queue.total),
      folder_queue_summary: folderSummary.rows,
    };
  }

  async getSdrStatus(tenantId: string, userId: string) {
    const [settings, sdr, pool] = await Promise.all([
      this.getSettings(tenantId),
      this.db.query(`SELECT id, name, available, state, current_pause_id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [tenantId, userId]),
      // Per-tenant lines: expose only whether a line is available, never how many.
      this.db.query(`SELECT EXISTS (SELECT 1 FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now())) AS ready`, [tenantId]),
    ]);
    return { running: Boolean(settings?.running), sdr: sdr.rows[0] ?? null, line_ready: Boolean(pool.rows[0]?.ready) };
  }

  async tick(tenantId = legacyTenantId()) {
    const tickToken = randomUUID();
    const tickLock = `zapcall:tenant:${tenantId}:lock:dialer-tick`;
    if (!await this.redis.acquireLock(tickLock, tickToken, 30_000)) return;
    if (this.ticking.has(tenantId)) { await this.redis.releaseLock(tickLock, tickToken); return; }
    this.ticking.add(tenantId);
    try {
      await this.expireReservations(tenantId);
      const lastStatusSyncAt = this.lastStatusSyncAt.get(tenantId) ?? 0;
      if (Date.now() - lastStatusSyncAt >= 15000) {
        this.lastStatusSyncAt.set(tenantId, Date.now());
        await this.syncNumberStatuses(tenantId);
      }
      const settings = await this.getSettings(tenantId);
      if (!settings?.running) return;
      const [sdrs, numbers, leads, activeFolderCount] = await Promise.all([
        this.db.query(`
            SELECT s.* FROM sdrs s
            WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM calls c
                WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
            )
          ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
        `, [tenantId]),
        this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) AND (last_call_ended_at IS NULL OR last_call_ended_at <= now() - (cooldown_seconds * interval '1 second')) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
          this.db.query(`
          WITH active_folders AS (
            SELECT f.id, (ROW_NUMBER() OVER (ORDER BY f.sort_order ASC, f.created_at ASC) - 1)::int AS folder_index,
              COUNT(*) OVER ()::int AS folder_count
            FROM lead_folders f
            WHERE f.tenant_id = $1 AND f.is_active = true
          ), eligible AS (
            SELECT l.*, f.name AS folder_name, f.sort_order AS folder_sort_order,
              af.folder_index, af.folder_count,
              ROW_NUMBER() OVER (PARTITION BY l.folder_id ORDER BY l.next_eligible_at ASC, l.created_at ASC)::int AS folder_rank
            FROM leads l
            JOIN active_folders af ON af.id = l.folder_id
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
              AND l.last_auto_round < $3 AND l.next_eligible_at <= now()
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          )
          SELECT * FROM eligible
          ORDER BY ((folder_index - ($4 % folder_count) + folder_count) % folder_count) ASC,
            folder_rank ASC, next_eligible_at ASC, created_at ASC
          LIMIT 25
        `, [tenantId, settings.max_attempts_per_lead, Number(settings.dialer_round ?? 1), Number(settings.folder_rotation_cursor ?? 0)]),
        this.db.query(`SELECT count(*)::int AS count FROM lead_folders WHERE tenant_id = $1 AND is_active = true`, [tenantId]),
      ]);

      for (let i = 0; i < Math.min(sdrs.rows.length, numbers.rows.length, leads.rows.length); i++) {
        const sdr = sdrs.rows[i];
        if (!this.gateway.isConnected(sdr.id)) continue;
        const lead = leads.rows[i];
        // Skip self-calls: WhatsApp closes the media immediately when the line
        // dials its own number. Pick another connected line if available.
        const number = numbers.rows.find((row: any) => this.normalizePhone(row.phone) !== this.normalizePhone(lead.phone));
        if (!number) continue;
        const token = randomUUID();
        const reserved = await this.redis.reserve({
          tenantId, token, globalMax: settings.global_max_concurrent_calls,
          numberMax: number.max_concurrent_calls, numberId: number.id,
          leadId: lead.id, sdrId: sdr.id,
          ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
        });
        if (!reserved) continue;

        try {
          await this.startReservedCall(sdr, number, lead, settings, token, 'automatico', tenantId);
        } catch (error) {
          this.logger.error(`Could not reserve call: ${String(error)}`);
        }
      }
      const round = Number(settings.dialer_round ?? 1);
      const roundState = await this.db.query(`
        SELECT
          EXISTS (
            SELECT 1
            FROM leads l
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
              AND l.last_auto_round < $3 AND l.next_eligible_at <= now()
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          ) AS has_ready_unattempted,
          EXISTS (
            SELECT 1
            FROM leads l
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait', 'reserved', 'dialing', 'media_active')
              AND l.attempts < $2
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          ) AS has_retryable_leads
      `, [tenantId, settings.max_attempts_per_lead, round]);
      const state = roundState.rows[0];
      if (state?.has_retryable_leads && !state.has_ready_unattempted) {
        const advanced = await this.db.query(`
          UPDATE dialer_settings
          SET dialer_round = dialer_round + 1
          WHERE tenant_id = $1 AND dialer_round = $2
          RETURNING dialer_round
        `, [tenantId, round]);
        if (advanced.rows[0]) this.log(`Nova rodada automática iniciada: ${advanced.rows[0].dialer_round}`, 'info', undefined, tenantId);
      }
      const folderCount = Number(activeFolderCount.rows[0]?.count ?? 0);
      if (folderCount > 0) await this.db.query('UPDATE dialer_settings SET folder_rotation_cursor = ($1 + 1) % $2 WHERE tenant_id = $3', [Number(settings.folder_rotation_cursor ?? 0), folderCount, tenantId]);
    } catch (error) {
      this.logger.warn(`Dialer tick failed: ${String(error)}`);
    } finally {
      this.ticking.delete(tenantId);
      await this.redis.releaseLock(tickLock, tickToken);
    }
  }

  private async tickAllTenants() {
    const result = await this.db.query("SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
    for (const tenant of result.rows) await this.tick(tenant.id);
  }

  private async syncNumberStatuses(tenantId = legacyTenantId()) {
    const result = await this.db.query("SELECT id, tenant_id, waxum_session_id FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId]);
    for (const number of result.rows) {
      try {
        const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
        await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3 AND tenant_id = $4', [status.status, status.phone, number.id, tenantId]);
      } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode === 404) {
          await this.db.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1 AND tenant_id = $2`, [number.id, tenantId]);
        }
        // Waxum may be temporarily unavailable; keep the last status unless
        // the session is definitively missing.
      }
    }
  }

  private async startReservedCall(sdr: any, number: any, lead: any, settings: any, token: string, source: string, tenantId = legacyTenantId()) {
    const callId = randomUUID();
    const expires = new Date(Date.now() + Number(settings.ring_timeout_seconds) * 1000);
    const isAutomatic = source === 'automatico';
    try {
      await this.db.transaction(async (client) => {
        const folder = await client.query('SELECT folder_id, is_active FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.id = $2 FOR UPDATE', [tenantId, lead.id]);
        if (!folder.rows[0]?.is_active) throw new Error('A pasta deste lead está inativa');
        await client.query(`INSERT INTO calls (id, tenant_id, folder_id, lead_id, number_id, sdr_id, status, attempt_number, source, offer_expires_at) VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9)`, [callId, tenantId, folder.rows[0].folder_id, lead.id, number.id, sdr.id, isAutomatic ? Number(lead.attempts) + 1 : 0, source, expires]);
        if (isAutomatic) {
          await client.query(`UPDATE leads SET status = 'reserved', attempts = attempts + 1, last_auto_round = $1 WHERE tenant_id = $2 AND id = $3`, [Number(settings.dialer_round ?? 1), tenantId, lead.id]);
        }
        await client.query(`UPDATE sdrs SET available = false, state = 'in_call', last_assigned_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, sdr.id]);
      });
      this.active.set(callId, { tenantId, token, numberId: number.id, leadId: lead.id, sdrId: sdr.id, mediaActive: false });
      // Blind dialing: on automatic calls the SDR must not learn who is being
      // called until the lead actually answers (notifyAnswered reveals it).
      // Manual calls skip this — the SDR already chose the lead themselves.
      this.log(isAutomatic ? `Discagem automática iniciada via ${number.label}` : `Discando manual para ${lead.name} via ${number.label}`, 'info', callId, tenantId);
      const browser = this.gateway.getSocket(sdr.id);
      this.gateway.sendToSdr(sdr.id, { type: 'call_reserved', callId, lead: isAutomatic ? { id: lead.id } : { id: lead.id, name: lead.name, phone: lead.phone }, number: { id: number.id, label: number.label } });
      if (browser) void this.attachMedia(callId, sdr.id, browser, tenantId);
      return { callId, status: 'reserved' };
    } catch (error) {
      await this.redis.release({ tenantId, token, numberId: number.id, leadId: lead.id, sdrId: sdr.id });
      throw error;
    }
  }

  private async recoverInterruptedCalls() {
    const result = await this.db.query(`
      SELECT id, tenant_id FROM calls
      WHERE status IN ('reserved', 'dialing', 'media_active')
    `);
    for (const row of result.rows) {
      try {
        await this.finishCall(row.id, 'failed', 'api_restarted', false, row.tenant_id);
      } catch (error) {
        this.logger.error(`Could not recover call ${row.id}: ${String(error)}`);
      }
    }
  }

  private async resetStaleSdrPresence() {
    await this.db.query(`UPDATE sdrs SET available = false, session_id = '', state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END`);
  }

  private async expireReservations(tenantId = legacyTenantId()) {
    const result = await this.db.query(`SELECT id FROM calls WHERE tenant_id = $1 AND status = 'reserved' AND offer_expires_at < now()`, [tenantId]);
    for (const row of result.rows) await this.finishCall(row.id, 'cancelled', 'sdr_offer_timeout', true, tenantId);
  }

  private notifyAnswered(callId: string, sdrId: string, row: any, resource: CallResource) {
    if (resource.sdrNotified || resource.finishing) return;
    resource.sdrNotified = true;
    this.gateway.sendToSdr(sdrId, {
      type: 'call_started', callId,
      lead: { id: row.lead_id, name: row.name, phone: row.phone },
      number: { id: row.number_id, label: row.label },
      connectedAt: new Date().toISOString(),
      expiresAt: row.offer_expires_at,
    });
    if (resource.media?.readyState === WebSocket.OPEN) this.gateway.sendToSdr(sdrId, { type: 'media_open', callId });
  }

  async attachMedia(callId: string, sdrId: string, browser: WebSocket, tenantId = legacyTenantId()) {
    const resource = this.active.get(callId);
    if (!resource || resource.tenantId !== tenantId || resource.sdrId !== sdrId) return browser.close(1008, 'call not assigned');
    const call = await this.db.query(`SELECT c.*, n.waxum_session_id, n.label, l.name, l.phone FROM calls c JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
    if (!call.rows[0]) return browser.close(1008, 'call not found');
    resource.browser = browser;
    resource.answerAbort = new AbortController();
    try {
      const settings = await this.getSettings(tenantId);
      let recipient: string;
      try {
        recipient = await this.resolveRecipient(call.rows[0].waxum_session_id, call.rows[0].phone);
        this.log(`Destinatario VoIP resolvido para ${recipient}`, 'info', callId);
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        const message = String(err.message ?? error);
        // A 429 while learning the LID is transient: back the line off instead
        // of failing the lead, so we don't burn its attempt budget.
        if (err.statusCode === 429 || /\b429\b/.test(message)) {
          const wait = Number(message.match(/wait for\s+(\d+)/i)?.[1]);
          this.applyRateLimitBackoff(callId, resource, Number.isFinite(wait) ? wait : undefined);
          return;
        }
        // not_on_whatsapp / lid_unavailable: the number cannot receive a VoIP
        // call. Do not retry it in a loop — finish without a retry so it leaves
        // the queue and the organizer sees why.
        const uncallable = message === 'not_on_whatsapp' || message === 'lid_unavailable';
        this.log(uncallable ? `Lead sem WhatsApp disponível para chamada (${message})` : `Waxum nao conseguiu preparar o destinatario: ${message}`, uncallable ? 'warning' : 'error', callId);
        await this.finishCall(callId, 'failed', uncallable ? `sem_whatsapp:${message}` : `waxum_recipient_error:${message}`, uncallable);
        return;
      }
      if (resource.finishing) return;
      const media = this.waxum.openMedia(call.rows[0].waxum_session_id, recipient);
      resource.media = media;
      resource.callPlacedAt = Date.now();
      resource.ringTimeout = setTimeout(() => {
        if (!resource.mediaActive && !resource.answerSignalReceived) void this.finishCall(callId, 'no_answer', 'ring_timeout').catch((error) => this.logger.error(`Could not finish timed out call ${callId}: ${String(error)}`));
      }, Number(settings.ring_timeout_seconds) * 1000);

      media.on('open', () => {
        resource.mediaOpen = true;
        if (browser.readyState === WebSocket.OPEN) {
          try { browser.send(JSON.stringify({ type: 'media_open' })); } catch { /* browser disconnected */ }
        }
      });
      media.on('message', (data, isBinary) => {
        // Waxum generates its own call id. It is different from the ZapLiga
        // database id and is the id carried by WhatsApp Accept events.
        if (!isBinary) {
          try {
            const metadata = JSON.parse(data.toString()) as { type?: string; call_id?: string };
            if (metadata.type === 'call_started' && metadata.call_id && !resource.answerWatcherStarted) {
              resource.waxumCallId = metadata.call_id;
              resource.answerWatcherStarted = true;
              this.log(`Chamada Waxum iniciada (${metadata.call_id}); aguardando atendimento`, 'info', callId);
              void this.waxum.waitForOutgoingAnswer(call.rows[0].waxum_session_id, metadata.call_id, resource.answerAbort!.signal)
                .then((answered) => {
                  if (!answered || resource.finishing || resource.mediaActive) return;
                  resource.answerSignalReceived = true;
                  this.notifyAnswered(callId, sdrId, call.rows[0], resource);
                  this.log('Atendimento sinalizado pelo WhatsApp; aguardando mídia pós-atendimento', 'info', callId);
                })
                .catch((error) => {
                  if ((error as Error & { name?: string }).name === 'AbortError' || resource.finishing) return;
                  this.log(`Não foi possível confirmar o atendimento: ${String(error)}`, 'warning', callId);
                });
            }
          } catch (error) {
            this.log(`Metadados de mídia inválidos: ${String(error)}`, 'warning', callId);
          }
          return;
        }
        // Any media frame means the relay attached endpoints — the call
        // reached the ringing/media stage, so the line is NOT reachout-blocked.
        resource.receivedAnyFrame = true;
        // Um frame de mídia pode chegar enquanto o WhatsApp ainda está tocando.
        // Ele não confirma atendimento e não deve chegar ao SDR.
        if (!resource.answerSignalReceived) {
          if (!resource.answerEventLogged) {
            resource.answerEventLogged = true;
            this.log('Áudio recebido durante o toque; aguardando confirmação de atendimento', 'info', callId);
          }
          return;
        }
        const firstActiveFrame = !resource.mediaActive;
        resource.mediaActive = true;
        if (firstActiveFrame) {
          if (resource.ringTimeout) clearTimeout(resource.ringTimeout);
          resource.ringTimeout = undefined;
          void this.db.query(`UPDATE calls SET status = 'media_active', started_at = COALESCE(started_at, now()), connected_at = now() WHERE tenant_id = $1 AND id = $2`, [resource.tenantId, callId]);
          this.notifyAnswered(callId, sdrId, call.rows[0], resource);
          this.gateway.sendToSdr(sdrId, { type: 'media_active', callId });
          this.log('Cliente aceitou a chamada; áudio liberado para o SDR', 'info', callId);
        }
        if (browser.readyState === WebSocket.OPEN) {
          try { browser.send(data, { binary: true }); } catch { /* browser disconnected */ }
        }
      });
      media.on('error', (error) => {
        if (/unexpected server response:\s*429/i.test(error.message)) {
          this.applyRateLimitBackoff(callId, resource);
          return;
        }
        this.log(`Erro no Waxum: ${error.message}`, 'error', callId);
        void this.finishCall(callId, 'failed', `waxum_error:${error.message}`).catch((finishError) => this.logger.error(`Could not finish Waxum error for ${callId}: ${String(finishError)}`));
      });
      media.on('unexpected-response', (_request, response) => {
        const statusCode = response.statusCode;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { if (chunks.length < 8) chunks.push(chunk); });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (statusCode === 429) {
            const waitSeconds = Number(body.match(/wait for\s+(\d+)\s*s/i)?.[1]);
            this.applyRateLimitBackoff(callId, resource, Number.isFinite(waitSeconds) ? waitSeconds : undefined);
            return;
          }
          this.log(`Waxum recusou a conexão de mídia (HTTP ${statusCode})`, 'error', callId);
          void this.finishCall(callId, 'failed', `waxum_http_error:${statusCode}`)
            .catch((finishError) => this.logger.error(`Could not finish Waxum HTTP error for ${callId}: ${String(finishError)}`));
        });
        response.resume();
      });
      media.on('close', (code, reason) => {
        const detail = reason.toString().trim();
        const closeReason = detail ? `waxum_closed:${code}:${detail}` : `waxum_closed:${code}`;
        const gotSignal = resource.mediaActive || resource.receivedAnyFrame || resource.answerSignalReceived;
        const elapsed = Date.now() - (resource.callPlacedAt ?? Date.now());
        if (gotSignal) {
          // Healthy call (audio/answer reached) — the line is fine; clear any
          // instant-failure streak.
          this.lineFailures.delete(resource.numberId);
        } else if (elapsed < this.FLAG_FAST_FAIL_MS) {
          // Opened then died instantly with no audio: reachout-block signature.
          void this.registerLineInstantFailure(resource.numberId, resource.tenantId, callId)
            .catch((error) => this.logger.error(`Could not register line failure for ${callId}: ${String(error)}`));
        }
        void this.finishCall(callId, resource.mediaActive ? 'completed' : 'no_answer', resource.mediaActive ? 'remote_hangup' : closeReason)
          .catch((error) => this.logger.error(`Could not finish closed call ${callId}: ${String(error)}`));
      });
      resource.browserMessageHandler = (data, isBinary) => {
        // Start forwarding microphone PCM as soon as Waxum accepts the media
        // socket. Waiting for the first inbound frame can deadlock the bridge:
        // some calls only produce inbound audio after receiving an uplink
        // frame from the browser.
        if (isBinary && !resource.mediaOpen) return;
        if (isBinary && !resource.browserAudioLogged && Buffer.byteLength(data as any) > 0) {
          resource.browserAudioLogged = true;
          this.log(`Audio do microfone recebido (${Buffer.byteLength(data as any)} bytes)`, 'info', callId);
        }
        if (isBinary && media.readyState === WebSocket.OPEN) media.send(data, { binary: true });
      };
      resource.browserCloseHandler = () => {
        void this.finishCall(callId, resource.mediaActive ? 'failed' : 'cancelled', 'browser_disconnected')
          .catch((error) => this.logger.error(`Could not finish browser-disconnected call ${callId}: ${String(error)}`));
      };
      resource.browserErrorHandler = () => {
        void this.finishCall(callId, 'failed', 'browser_error')
          .catch((error) => this.logger.error(`Could not finish browser-error call ${callId}: ${String(error)}`));
      };
      browser.on('message', resource.browserMessageHandler);
      browser.on('close', resource.browserCloseHandler);
      browser.on('error', resource.browserErrorHandler);
    } catch (error) {
      await this.finishCall(callId, 'failed', String(error));
    }
  }

  async recordOutcome(callId: string, outcome: string, tenantId = legacyTenantId(), sdrId?: string) {
    const resource = this.active.get(callId);
    if (resource && (resource.tenantId !== tenantId || (sdrId && resource.sdrId !== sdrId))) throw new Error('Chamada não pertence ao SDR autenticado');
    const isBrowserAudioFailure = outcome === 'microphone_denied' || outcome === 'browser_error' || outcome.startsWith('audio_error:');
    const isCancel = outcome === 'sdr_cancelled';
    if (resource) return this.finishCall(callId, isBrowserAudioFailure ? 'failed' : isCancel ? 'cancelled' : 'completed', outcome);
    const ownership = sdrId ? ' AND sdr_id = $4' : '';
    await this.db.query(`UPDATE calls SET outcome = $1 WHERE tenant_id = $2 AND id = $3${ownership}`, sdrId ? [outcome, tenantId, callId, sdrId] : [outcome, tenantId, callId]);
    return { ok: true };
  }

  async handleSdrDisconnected(sdrId: string, tenantId = legacyTenantId()) {
    for (const [callId, resource] of this.active.entries()) {
      if (resource.tenantId === tenantId && resource.sdrId === sdrId) await this.finishCall(callId, 'failed', 'sdr_disconnected', false, tenantId);
    }
    await this.db.query(`UPDATE sdrs SET available = false, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END WHERE tenant_id = $1 AND id = $2`, [tenantId, sdrId]);
  }

  private applyRateLimitBackoff(callId: string, resource: CallResource | undefined, waitSeconds?: number) {
    // WhatsApp/Waxum throttles outbound call initiation. When it answers 429
    // ("wait for Ns"), honor that window on the WhatsApp line instead of
    // re-dialing every tick. Re-dialing immediately keeps the rate-limit
    // window permanently open, so no call ever gets to ring.
    // Floor the backoff ABOVE WhatsApp's largest observed call-rate window
    // (~177s). If we retry a line before its penalty window clears, the attempt
    // just refreshes the window and the session never recovers. 180s+ ensures
    // the window expires before we dial that line again, so it self-heals.
    const backoff = Math.min(600, Math.max(180, Math.round(waitSeconds ?? 180)));
    if (resource) resource.rateLimitBackoffSeconds = backoff;
    this.log(`Waxum limitou a linha (429); aguardando ${backoff}s antes de discar novamente nela`, 'warning', callId);
    void this.finishCall(callId, 'cancelled', 'waxum_rate_limited')
      .catch((finishError) => this.logger.error(`Could not finish Waxum rate limit for ${callId}: ${String(finishError)}`));
  }

  // A call that opens the media socket but closes almost immediately with no
  // audio and no answer is the signature of a WhatsApp reachout timelock
  // (463 MissingTcToken): the relay attaches no endpoints. After a couple of
  // these in a row on the same line, quarantine it so the dialer routes to
  // healthy lines instead of hammering (and deepening the penalty on) a
  // flagged account. A single call that produces audio resets the counter.
  private async registerLineInstantFailure(numberId: string, tenantId: string, callId: string) {
    const count = (this.lineFailures.get(numberId) ?? 0) + 1;
    this.lineFailures.set(numberId, count);
    if (count < this.FLAG_FAILURE_THRESHOLD) return;
    this.lineFailures.delete(numberId);
    const hours = this.flagQuarantineHours;
    await this.db.query(`UPDATE whatsapp_numbers SET flagged_until = now() + ($1 * interval '1 hour') WHERE id = $2 AND tenant_id = $3`, [hours, numberId, tenantId]);
    const label = await this.db.query(`SELECT label FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2`, [numberId, tenantId]);
    this.log(`Linha "${label.rows[0]?.label ?? numberId}" parece bloqueada pelo WhatsApp (chamadas caindo na hora, sem tocar); pausada por ${hours}h para proteger a conta. O discador usará as outras linhas.`, 'error', callId, tenantId);
    this.gateway.broadcast({ type: 'number_flagged', numberId, flaggedHours: hours }, tenantId);
  }

  private async finishCall(callId: string, status: string, reason?: string, forceNoRetry = false, tenantId = legacyTenantId()) {
    if (this.finishingCalls.has(callId)) return;
    this.finishingCalls.add(callId);
    const resource = this.active.get(callId);
    try {
      if (resource) {
        tenantId = resource.tenantId;
        resource.finishing = true;
        resource.answerAbort?.abort();
        if (resource.ringTimeout) clearTimeout(resource.ringTimeout);
        if (resource.browser && resource.browserMessageHandler) resource.browser.off('message', resource.browserMessageHandler);
        if (resource.browser && resource.browserCloseHandler) resource.browser.off('close', resource.browserCloseHandler);
        if (resource.browser && resource.browserErrorHandler) resource.browser.off('error', resource.browserErrorHandler);
        if (resource.media && resource.media.readyState === WebSocket.OPEN) resource.media.close();
      }
      const call = await this.db.query(`SELECT c.*, s.id AS sdr_id, n.id AS number_id, n.cooldown_seconds, l.attempts, ds.max_attempts_per_lead, ds.retry_delay_minutes FROM calls c JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN dialer_settings ds ON ds.tenant_id = c.tenant_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
      if (!call.rows[0]) return;
      const row = call.rows[0];
      if (['completed', 'no_answer', 'failed', 'cancelled'].includes(row.status)) return;
      const outcome = reason ?? status;
      const transientRateLimit = outcome === 'waxum_rate_limited';
      const isAutomatic = row.source !== 'manual';
      const retryable = isAutomatic && !transientRateLimit && ['no_answer', 'failed'].includes(status) && !forceNoRetry && Number(row.attempts) < Number(row.max_attempts_per_lead);
      const finalCallStatus = transientRateLimit ? 'cancelled' : retryable ? 'retry_wait' : status;
      const leadStatus = transientRateLimit ? 'queued' : retryable ? 'retry_wait' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'queued' : status;
      const requiresPostCall = Boolean(row.connected_at);
      let pause: any = null;
      this.log(`Chamada encerrada: ${finalCallStatus} (${outcome})`, transientRateLimit ? 'warning' : finalCallStatus === 'failed' ? 'error' : 'info', callId);
      await this.db.transaction(async (client) => {
        await client.query(`UPDATE calls SET status = $1, ended_at = now(), duration_seconds = CASE WHEN COALESCE(connected_at, started_at) IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - COALESCE(connected_at, started_at)))::int END, ring_duration_seconds = CASE WHEN started_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(connected_at, now()) - started_at))::int) END, connected_duration_seconds = CASE WHEN connected_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - connected_at))::int) END, outcome = $2, failure_reason = CASE WHEN $4 IN ('failed','no_answer') OR $2 = 'waxum_rate_limited' THEN $2 ELSE failure_reason END WHERE tenant_id = $5 AND id = $3 AND status NOT IN ('completed','no_answer','failed','cancelled')`, [finalCallStatus, outcome, callId, status, tenantId]);
        if (!isAutomatic) {
          // Manual calls must not alter the automatic queue or attempt budget.
        } else if (transientRateLimit) {
          await client.query(`UPDATE leads SET status = 'queued', attempts = GREATEST(0, attempts - 1), next_eligible_at = now() + interval '10 seconds' WHERE tenant_id = $1 AND id = $2`, [tenantId, row.lead_id]);
        } else if (retryable) {
          await client.query(`UPDATE leads SET status = $2, next_eligible_at = now() + ($1::int * interval '1 minute') WHERE tenant_id = $3 AND id = $4`, [row.retry_delay_minutes, leadStatus, tenantId, row.lead_id]);
        } else {
          await client.query(`UPDATE leads SET status = $1, next_eligible_at = now() WHERE tenant_id = $2 AND id = $3`, [leadStatus, tenantId, row.lead_id]);
        }
        if (requiresPostCall) {
          const pauseId = randomUUID();
          const pauseResult = await client.query(`
            INSERT INTO sdr_pauses (id, tenant_id, sdr_id, call_id, pause_type)
            VALUES ($1, $2, $3, $4, 'post_call')
            RETURNING id, pause_type, started_at
          `, [pauseId, tenantId, row.sdr_id, callId]);
          pause = {
            id: pauseResult.rows[0].id,
            pause_type: pauseResult.rows[0].pause_type,
            started_at: pauseResult.rows[0].started_at,
            call_id: callId,
            lead_name: row.name,
            lead_phone: row.phone,
            call_started_at: row.connected_at,
            call_duration_seconds: row.connected_at ? Math.max(0, Math.floor((Date.now() - new Date(row.connected_at).getTime()) / 1000)) : 0,
          };
          await client.query(`UPDATE sdrs SET available = false, state = 'post_call', current_pause_id = $1 WHERE tenant_id = $2 AND id = $3`, [pauseId, tenantId, row.sdr_id]);
        } else {
          await client.query(`UPDATE sdrs SET available = true, state = 'available', current_pause_id = NULL WHERE tenant_id = $1 AND id = $2`, [tenantId, row.sdr_id]);
        }
        if (transientRateLimit) {
          // WhatsApp rate-limited this line. Push its next-eligible time out by
          // the requested backoff so the dialer stops hammering it every tick.
          // The eligibility gate is `last_call_ended_at <= now() - cooldown`, so
          // future-dating it by (backoff - cooldown) makes the line eligible
          // again only after `backoff` seconds.
          const backoff = Math.min(600, Math.max(Number(row.cooldown_seconds ?? 60), Number(resource?.rateLimitBackoffSeconds ?? 180)));
          await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() + (($1::int - cooldown_seconds) * interval '1 second') WHERE id = $2`, [backoff, row.number_id]);
        } else {
          await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() WHERE id = $1`, [row.number_id]);
        }
      });
      if (resource) await this.redis.release({ tenantId: resource.tenantId, token: resource.token, numberId: resource.numberId, leadId: resource.leadId, sdrId: resource.sdrId });
      this.gateway.sendToSdr(row.sdr_id, { type: 'call_finished', callId, status: finalCallStatus, outcome, pause });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId: row.sdr_id, state: requiresPostCall ? 'post_call' : 'available', available: !requiresPostCall, pause }, tenantId);
    } finally {
      this.active.delete(callId);
      this.finishingCalls.delete(callId);
    }
  }
}
