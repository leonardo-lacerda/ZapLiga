import { BadRequestException, Body, Controller, ConflictException, ForbiddenException, Get, HttpException, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { DialerService } from '../dialer/dialer.service';
import { FinishPauseDto } from './dto/finish-pause.dto';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class SdrsController {
  constructor(private readonly db: DatabaseService, private readonly dialer: DialerService, private readonly audit: AuditService, private readonly entitlement: EntitlementService) {}

  @Get(['/api/me/sdr', '/api/tenants/:tenantId/me/sdr'])
  @Roles('sdr')
  async own(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const existing = await this.db.query('SELECT id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, user.id]);
    if (existing.rows[0]) return this.dialer.getSdrState(existing.rows[0].id, tenantId);
    throw new NotFoundException('Perfil SDR ainda não foi criado');
  }

  @Post(['/api/me/sdr', '/api/tenants/:tenantId/me/sdr'])
  @Roles('sdr')
  @TenantAction('write')
  async createOwn(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.entitlement.assertAction(tenantId, 'write', user.id);
    const result = await this.db.transaction(async (client) => {
      await this.entitlement.acquireTenantLock(tenantId, client);
      const existing = await client.query('SELECT id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, user.id]);
      if (existing.rows[0]) return existing.rows[0];
      const profile = await client.query('SELECT name FROM users WHERE id = $1', [user.id]);
      return (await client.query(`INSERT INTO sdrs (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) RETURNING id`, [randomUUID(), tenantId, user.id, profile.rows[0]?.name ?? 'SDR'])).rows[0];
    });
    return this.dialer.getSdrState(result.id, tenantId);
  }

  @Get(['/api/sdrs', '/api/tenants/:tenantId/sdrs'])
  async list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const total = await this.db.query('SELECT count(*)::int AS total FROM sdrs s WHERE s.tenant_id = $1', [tenantId]);
    const items = await this.db.query(`
      SELECT s.*, u.name AS user_name, u.email AS user_email, u.status AS user_status, u.last_login_at,
        tm.status AS membership_status, p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
        c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
        c.connected_at AS pause_call_started_at,
        CASE WHEN p.started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - p.started_at))::int) END AS pause_elapsed_seconds
      FROM sdrs s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id
      LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
      LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
      LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = c.lead_id
      WHERE s.tenant_id = $1
      ORDER BY s.name
      LIMIT $2 OFFSET $3
    `, [tenantId, safeLimit, safeOffset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }

  @Get(['/api/sdrs/:id/state', '/api/tenants/:tenantId/sdrs/:id/state'])
  state(@Param('id') id: string, @CurrentTenant() tenantId: string) { return this.dialer.getSdrState(id, tenantId); }

  @Get(['/api/sdrs/:id/pauses', '/api/tenants/:tenantId/sdrs/:id/pauses'])
  pauses(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.db.query(`SELECT * FROM sdr_pauses WHERE tenant_id = $1 AND sdr_id = $2 ORDER BY started_at DESC LIMIT 100`, [tenantId, id]).then((result) => result.rows);
  }

  @Post(['/api/sdrs/:id/pauses/:pauseId/finish', '/api/tenants/:tenantId/sdrs/:id/pauses/:pauseId/finish'])
  @TenantAction('call_finalize')
  @Roles('leader', 'super_admin', 'sdr')
  async finishPause(@Param('id') id: string, @Param('pauseId') pauseId: string, @Body() body: FinishPauseDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    if (user.platformRole !== 'super_admin' && user.tenantMembership?.role === 'sdr') {
      const own = await this.db.query('SELECT 1 FROM sdrs WHERE tenant_id = $1 AND id = $2 AND user_id = $3 LIMIT 1', [tenantId, id, user.id]);
      if (!own.rows[0]) throw new ForbiddenException('Um SDR só pode finalizar o próprio pós-atendimento');
    }
    try {
      const result = await this.dialer.finishPause(id, pauseId, { ...body, actorUserId: user.id }, tenantId);
      if (body.callResult === 'nao_ligar_novamente') await this.audit.record({ actorUserId: user.id, tenantId, action: 'contact.suppressed', entityType: 'lead', metadata: { source: 'post_call', reason: 'requested_opt_out' } });
      return result;
    }
    catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(String((error as Error).message ?? error)); }
  }
}
