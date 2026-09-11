import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { AuditService } from '../audit/audit.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { CreateNumberDto } from './dto/create-number.dto';
import { UpdateNumberDto } from './dto/update-number.dto';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { EntitlementService } from '../billing/entitlement.service';
import { PlanLimitsService } from '../billing/plan-limits.service';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class NumbersController {
  private readonly qrRequests = new Map<string, Promise<any>>();
  private readonly waxumCreateCooldownKey = 'zapcall:waxum:create-session:cooldown';
  private readonly waxumCreateLockKey = 'zapcall:waxum:create-session:lock';

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient, private readonly audit: AuditService, private readonly redis: RedisService, private readonly entitlement: EntitlementService, private readonly planLimits: PlanLimitsService) {}

  @Roles('leader', 'super_admin')
  @Post(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  async create(@Body() body: CreateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.entitlement.assertAction(tenantId, 'write', user.id);
    const label = String(body.label ?? '').trim();
    if (!label) throw new BadRequestException('label é obrigatório');
    let createdSessionId: string | undefined;
    let persisted = false;
    try {
      const session = await this.createWaxumSession(label);
      createdSessionId = session.id;
      // A new line's cooldown defaults to the tenant's own "Proteção entre
      // chamadas" (Configurações do discador) instead of a hardcoded value,
      // so that setting stays the single place operators configure it.
      const dialerDefaults = await this.db.query('SELECT default_number_cooldown_seconds FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
      const defaultCooldownSeconds = Number(dialerDefaults.rows[0]?.default_number_cooldown_seconds ?? 60);
      const result = await this.db.transaction(async (client) => {
        // Keep the advisory lock, count and INSERT on one transaction.
        await this.planLimits.assertCanAddNumbers(tenantId, client, 1);
        return client.query(`INSERT INTO whatsapp_numbers (id,tenant_id,label,phone,waxum_session_id,max_concurrent_calls,cooldown_seconds,max_calls_per_window,call_window_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), tenantId, label, digits(body.phone) || null, session.id, Number(body.maxConcurrentCalls ?? 1), Number(body.cooldownSeconds ?? defaultCooldownSeconds), Number(body.maxCallsPerWindow ?? 3), Number(body.callWindowSeconds ?? 180)]);
      });
      persisted = true;
      await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.created', entityType: 'whatsapp_number', entityId: result.rows[0].id });
      return result.rows[0];
    } catch (error) {
      if (createdSessionId && !persisted) await this.waxum.deleteSession(createdSessionId).catch(() => undefined);
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(`Não foi possível criar a sessão Waxum: ${String(error)}`);
    }
  }

  @Roles('leader', 'super_admin')
  @Get(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  async list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const cacheKey = `zapcall:tenant:${tenantId}:numbers:${safeLimit}:${safeOffset}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) { try { return JSON.parse(cached); } catch { /* recompute corrupt cache */ } }
    const total = await this.db.query("SELECT count(*)::int AS total FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId]);
    const items = await this.db.query("SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed' ORDER BY created_at DESC LIMIT $2 OFFSET $3", [tenantId, safeLimit, safeOffset]);
    const response = { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'PX', 1500).catch(() => undefined);
    return response;
  }

  @Roles('leader', 'super_admin')
  @Delete(['/api/numbers/:id', '/api/tenants/:tenantId/numbers/:id'])
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.entitlement.assertAction(tenantId, 'write', user.id);
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
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.removed', entityType: 'whatsapp_number', entityId: id });
    return { ok: true, id, archived: true };
  }

  @Roles('leader', 'super_admin')
  @Get(['/api/numbers/:id/qr', '/api/tenants/:tenantId/numbers/:id/qr'])
  async qr(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    const requestKey = `${tenantId}:${id}`;
    const current = this.qrRequests.get(requestKey);
    if (current) return current;
    const request = this.loadQr(id, tenantId).finally(() => this.qrRequests.delete(requestKey));
    this.qrRequests.set(requestKey, request);
    return request;
  }

  @Roles('leader', 'super_admin')
  @Post(['/api/numbers/:id/reconnect', '/api/tenants/:tenantId/numbers/:id/reconnect'])
  async reconnect(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.entitlement.assertAction(tenantId, 'write', user.id);
    let number = await this.find(id, tenantId);
    try {
      const result = await this.waxum.reconnect(number.waxum_session_id);
      await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.reconnect_requested', entityType: 'whatsapp_number', entityId: id });
      return result;
    } catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      const result = await this.waxum.reconnect(number.waxum_session_id);
      await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.reconnect_requested', entityType: 'whatsapp_number', entityId: id });
      return result;
    }
  }

  @Roles('leader', 'super_admin')
  @Patch(['/api/numbers/:id/settings', '/api/tenants/:tenantId/numbers/:id/settings'])
  async settings(@Param('id') id: string, @Body() body: UpdateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.entitlement.assertAction(tenantId, 'write', user.id);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET max_concurrent_calls = COALESCE($1,max_concurrent_calls), cooldown_seconds = COALESCE($2,cooldown_seconds), max_calls_per_window = COALESCE($3,max_calls_per_window), call_window_seconds = COALESCE($4,call_window_seconds), label = COALESCE($5,label) WHERE id = $6 AND tenant_id = $7 AND status <> 'removed' RETURNING *`, [body.maxConcurrentCalls == null ? null : Number(body.maxConcurrentCalls), body.cooldownSeconds == null ? null : Number(body.cooldownSeconds), body.maxCallsPerWindow == null ? null : Number(body.maxCallsPerWindow), body.callWindowSeconds == null ? null : Number(body.callWindowSeconds), body.label ? String(body.label) : null, id, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.settings_changed', entityType: 'whatsapp_number', entityId: id });
    return result.rows[0];
  }

  private async find(id: string, tenantId: string) {
    const result = await this.db.query('SELECT * FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    return result.rows[0];
  }

  private async replaceMissingSession(number: any) {
    const session = await this.createWaxumSession(number.label);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET waxum_session_id = $1, status = 'disconnected' WHERE id = $2 AND tenant_id = $3 RETURNING *`, [session.id, number.id, number.tenant_id]);
    return result.rows[0];
  }

  /**
   * Session creation is a Waxum control-plane operation. Serialize it across
   * both API instances and persist a 429 cooldown in Redis so browser retries
   * cannot create a penalty storm after a restart.
   */
  private async createWaxumSession(label: string) {
    const cooldown = await this.redis.client.ttl(this.waxumCreateCooldownKey).catch(() => -1);
    if (cooldown > 0) throw this.waxumCooldownError(cooldown);

    const token = randomUUID();
    const locked = await this.redis.acquireLock(this.waxumCreateLockKey, token, 30_000).catch(() => false);
    if (!locked) throw new HttpException('Outra criação de sessão está em andamento. Aguarde alguns segundos.', HttpStatus.TOO_MANY_REQUESTS);

    try {
      const lockCooldown = await this.redis.client.ttl(this.waxumCreateCooldownKey).catch(() => -1);
      if (lockCooldown > 0) throw this.waxumCooldownError(lockCooldown);
      return await this.waxum.createSession(label);
    } catch (error) {
      // A cooldown generated by this controller already contains the exact
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
    let number = await this.find(id, tenantId);
    let payload: any;
    try { payload = await this.loadQrFromSession(number.waxum_session_id); }
    catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      payload = await this.loadQrFromSession(number.waxum_session_id);
    }
    const status = await this.refreshNumberStatus(number);
    return status.connected ? { ...payload, status: 'connected', phone_number: status.phone } : payload;
  }

  private async refreshNumberStatus(number: any) {
    const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
    await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3 AND tenant_id = $4', [status.status, status.phone, number.id, number.tenant_id]);
    return status;
  }

  private async loadQrFromSession(sessionId: string) {
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
