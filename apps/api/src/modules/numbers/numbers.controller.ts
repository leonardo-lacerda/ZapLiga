import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { AuditService } from '../audit/audit.service';
import { legacyTenantId } from '../../database/tenant-context';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { CreateNumberDto } from './dto/create-number.dto';
import { UpdateNumberDto } from './dto/update-number.dto';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class NumbersController {
  private readonly qrRequests = new Map<string, Promise<any>>();

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient, private readonly audit: AuditService) {}

  @Roles('super_admin')
  @Post(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  async create(@Body() body: CreateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const label = String(body.label ?? '').trim();
    if (!label) throw new BadRequestException('label é obrigatório');
    const quota = await this.db.query(`SELECT t.max_numbers, count(n.id)::int AS current FROM tenants t LEFT JOIN whatsapp_numbers n ON n.tenant_id = t.id AND n.status <> 'removed' WHERE t.id = $1 GROUP BY t.id, t.max_numbers`, [tenantId]);
    if (Number(quota.rows[0]?.current ?? 0) >= Number(quota.rows[0]?.max_numbers ?? 50)) throw new ConflictException('O limite de números desta empresa foi atingido');
    try {
      const session = await this.waxum.createSession(label);
      const result = await this.db.query(`INSERT INTO whatsapp_numbers (id,tenant_id,label,phone,waxum_session_id,max_concurrent_calls,cooldown_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), tenantId, label, digits(body.phone) || null, session.id, Number(body.maxConcurrentCalls ?? 1), Number(body.cooldownSeconds ?? 60)]);
      await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.created', entityType: 'whatsapp_number', entityId: result.rows[0].id });
      return result.rows[0];
    } catch (error) { throw new BadRequestException(`Não foi possível criar a sessão Waxum: ${String(error)}`); }
  }

  @Roles('leader', 'super_admin')
  @Get(['/api/numbers', '/api/tenants/:tenantId/numbers'])
  list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    return this.db.query("SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed' ORDER BY created_at DESC LIMIT $2 OFFSET $3", [tenantId, safeLimit, safeOffset]).then((result) => result.rows);
  }

  @Roles('super_admin')
  @Delete(['/api/numbers/:id', '/api/tenants/:tenantId/numbers/:id'])
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const number = await this.find(id, tenantId);
    const active = await this.db.query("SELECT 1 FROM calls WHERE tenant_id = $1 AND number_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1", [tenantId, id]);
    if (active.rows[0]) throw new BadRequestException('Nao e possivel remover um numero durante uma chamada');

    try {
      await this.waxum.deleteSession(number.waxum_session_id);
    } catch (error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode;
      if (statusCode !== 404) throw new BadRequestException(`Nao foi possivel remover a sessao Waxum: ${String(error)}`);
    }

    await this.db.query("UPDATE whatsapp_numbers SET status = 'removed' WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.removed', entityType: 'whatsapp_number', entityId: id });
    return { ok: true, id, archived: true };
  }

  @Roles('super_admin')
  @Get(['/api/numbers/:id/qr', '/api/tenants/:tenantId/numbers/:id/qr'])
  async qr(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    const requestKey = `${tenantId}:${id}`;
    const current = this.qrRequests.get(requestKey);
    if (current) return current;
    const request = this.loadQr(id, tenantId).finally(() => this.qrRequests.delete(requestKey));
    this.qrRequests.set(requestKey, request);
    return request;
  }

  @Roles('super_admin')
  @Post(['/api/numbers/:id/reconnect', '/api/tenants/:tenantId/numbers/:id/reconnect'])
  async reconnect(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    let number = await this.find(id, tenantId);
    try { return await this.waxum.reconnect(number.waxum_session_id); }
    catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode !== 404) throw error;
      number = await this.replaceMissingSession(number);
      return this.waxum.reconnect(number.waxum_session_id);
    }
  }

  @Roles('super_admin')
  @Patch(['/api/numbers/:id/settings', '/api/tenants/:tenantId/numbers/:id/settings'])
  async settings(@Param('id') id: string, @Body() body: UpdateNumberDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const result = await this.db.query(`UPDATE whatsapp_numbers SET max_concurrent_calls = COALESCE($1,max_concurrent_calls), cooldown_seconds = COALESCE($2,cooldown_seconds), label = COALESCE($3,label) WHERE tenant_id = $4 AND id = $5 AND status <> 'removed' RETURNING *`, [body.maxConcurrentCalls == null ? null : Number(body.maxConcurrentCalls), body.cooldownSeconds == null ? null : Number(body.cooldownSeconds), body.label ? String(body.label) : null, tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'number.settings_changed', entityType: 'whatsapp_number', entityId: id });
    return result.rows[0];
  }

  private async find(id: string, tenantId = legacyTenantId()) {
    const result = await this.db.query('SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Número não encontrado');
    return result.rows[0];
  }

  private async replaceMissingSession(number: any) {
    const session = await this.waxum.createSession(number.label);
    const result = await this.db.query(`UPDATE whatsapp_numbers SET waxum_session_id = $1, status = 'disconnected' WHERE tenant_id = $2 AND id = $3 RETURNING *`, [session.id, number.tenant_id, number.id]);
    return result.rows[0];
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
    await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE tenant_id = $3 AND id = $4', [status.status, status.phone, number.tenant_id, number.id]);
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
