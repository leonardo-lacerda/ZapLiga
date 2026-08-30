import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DialerService } from '../dialer/dialer.service';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { ManualCallDto } from './dto/manual-call.dto';
import { OutcomeDto } from './dto/outcome.dto';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class CallsController {
  constructor(private readonly db: DatabaseService, private readonly dialer: DialerService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  @Get(['/api/calls', '/api/tenants/:tenantId/calls'])
  async list(
    @Query('limit') limit = '100',
    @Query('offset') offset = '0',
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('search') search: string | undefined,
    @Query('status') status: string | undefined,
    @Query('result') result: string | undefined,
    @CurrentTenant() tenantId: string,
  ) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const cacheKey = `zapcall:tenant:${tenantId}:calls:${safeLimit}:${safeOffset}:${from ?? ''}:${to ?? ''}:${search?.trim().toLowerCase() ?? ''}:${status ?? ''}:${result ?? ''}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) { try { return JSON.parse(cached); } catch { /* recompute corrupt cache */ } }
    const isValidDate = (value?: string) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
    const conditions = ['c.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (isValidDate(from)) { params.push(`${from}T00:00:00.000Z`); conditions.push(`c.created_at >= $${params.length}`); }
    if (isValidDate(to)) { params.push(`${to}T23:59:59.999Z`); conditions.push(`c.created_at <= $${params.length}`); }
    if (status?.trim()) { params.push(status.trim()); conditions.push(`c.status = $${params.length}`); }
    if (result?.trim()) { params.push(result.trim()); conditions.push(`c.call_result = $${params.length}`); }
    if (search?.trim()) { params.push(`%${search.trim()}%`); conditions.push(`(l.name ILIKE $${params.length} OR l.phone ILIKE $${params.length} OR s.name ILIKE $${params.length})`); }
    const clause = conditions.join(' AND ');
    const joins = 'JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id';
    const total = await this.db.query(`SELECT count(*)::int AS total FROM calls c ${joins} WHERE ${clause}`, params);
    params.push(safeLimit, safeOffset);
    const items = await this.db.query(`SELECT c.*, l.name AS lead_name, l.phone AS lead_phone, l.pipeline_stage AS lead_pipeline_stage, n.label AS number_label, s.name AS sdr_name FROM calls c ${joins} WHERE ${clause} ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const response = { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'PX', 1500).catch(() => undefined);
    return response;
  }

  @Post(['/api/calls/manual', '/api/tenants/:tenantId/calls/manual'])
  @Roles('leader', 'super_admin', 'sdr')
  async manual(@Body() body: ManualCallDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const leadId = String(body.leadId ?? '').trim();
    const phone = String(body.phone ?? '').trim();
    if (!leadId && !phone) throw new BadRequestException('Informe um leadId ou telefone');
    const sdrUserId = user.platformRole === 'super_admin' || user.tenantMembership?.role !== 'sdr' ? undefined : user.id;
    try {
      const result = await this.dialer.manualCallWithInput({ leadId: leadId || undefined, phone: phone || undefined, name: body.name }, tenantId, sdrUserId);
      await this.audit.record({ actorUserId: user.id, tenantId, action: 'call.manual_started', entityType: 'lead', entityId: leadId || String(result.leadId ?? ''), metadata: result });
      return result;
    } catch (error) { throw new BadRequestException(String((error as Error).message ?? error)); }
  }

  @Post(['/api/calls/:id/outcome', '/api/tenants/:tenantId/calls/:id/outcome'])
  async outcome(@Param('id') id: string, @Body() body: OutcomeDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { const result = await this.dialer.recordOutcome(id, body.outcome, tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'call.outcome_recorded', entityType: 'call', entityId: id, metadata: { outcome: body.outcome } }); return result; }
}
