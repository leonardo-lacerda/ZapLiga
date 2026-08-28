import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { DialerService } from '../dialer/dialer.service';
import { FinishPauseDto } from './dto/finish-pause.dto';
import { AuditService } from '../audit/audit.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class SdrsController {
  constructor(private readonly db: DatabaseService, private readonly dialer: DialerService, private readonly audit: AuditService) {}

  @Get(['/api/me/sdr', '/api/tenants/:tenantId/me/sdr'])
  @Roles('sdr')
  async own(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const existing = await this.db.query('SELECT * FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, user.id]);
    if (existing.rows[0]) return existing.rows[0];
    await this.assertSdrQuota(tenantId);
    const profile = await this.db.query('SELECT name FROM users WHERE id = $1', [user.id]);
    const created = await this.db.query(`INSERT INTO sdrs (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) RETURNING *`, [randomUUID(), tenantId, user.id, profile.rows[0]?.name ?? 'SDR']);
    return created.rows[0];
  }

  private async assertSdrQuota(tenantId: string) {
    const quota = await this.db.query(`SELECT t.max_sdrs, count(s.id)::int AS current FROM tenants t LEFT JOIN sdrs s ON s.tenant_id = t.id WHERE t.id = $1 GROUP BY t.id, t.max_sdrs`, [tenantId]);
    if (Number(quota.rows[0]?.current ?? 0) >= Number(quota.rows[0]?.max_sdrs ?? 500)) throw new ConflictException('O limite de SDRs desta empresa foi atingido');
  }

  @Get(['/api/sdrs', '/api/tenants/:tenantId/sdrs'])
  list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    return this.db.query(`
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
    `, [tenantId, safeLimit, safeOffset]).then((result) => result.rows);
  }

  @Get(['/api/sdrs/:id/state', '/api/tenants/:tenantId/sdrs/:id/state'])
  state(@Param('id') id: string, @CurrentTenant() tenantId: string) { return this.dialer.getSdrState(id, tenantId); }

  @Get(['/api/sdrs/:id/pauses', '/api/tenants/:tenantId/sdrs/:id/pauses'])
  pauses(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.db.query(`SELECT * FROM sdr_pauses WHERE tenant_id = $1 AND sdr_id = $2 ORDER BY started_at DESC LIMIT 100`, [tenantId, id]).then((result) => result.rows);
  }

  @Post(['/api/sdrs/:id/pauses/:pauseId/finish', '/api/tenants/:tenantId/sdrs/:id/pauses/:pauseId/finish'])
  @Roles('leader', 'super_admin', 'sdr')
  async finishPause(@Param('id') id: string, @Param('pauseId') pauseId: string, @Body() body: FinishPauseDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    if (user.platformRole !== 'super_admin' && user.tenantMembership?.role === 'sdr') {
      const own = await this.db.query('SELECT 1 FROM sdrs WHERE tenant_id = $1 AND id = $2 AND user_id = $3 LIMIT 1', [tenantId, id, user.id]);
      if (!own.rows[0]) throw new ForbiddenException('Um SDR só pode finalizar o próprio pós-atendimento');
    }
    try { return await this.dialer.finishPause(id, pauseId, body, tenantId); }
    catch (error) { throw new BadRequestException(String((error as Error).message ?? error)); }
  }
}
