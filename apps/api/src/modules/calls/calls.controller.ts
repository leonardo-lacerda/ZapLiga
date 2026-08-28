import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DialerService } from '../dialer/dialer.service';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { ManualCallDto } from './dto/manual-call.dto';
import { OutcomeDto } from './dto/outcome.dto';
import { AuditService } from '../audit/audit.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class CallsController {
  constructor(private readonly db: DatabaseService, private readonly dialer: DialerService, private readonly audit: AuditService) {}

  @Get(['/api/calls', '/api/tenants/:tenantId/calls'])
  list(@Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    return this.db.query(`SELECT c.*, l.name AS lead_name, l.phone AS lead_phone, l.pipeline_stage AS lead_pipeline_stage, n.label AS number_label, s.name AS sdr_name FROM calls c JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id WHERE c.tenant_id = $1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`, [tenantId, safeLimit, safeOffset]).then((result) => result.rows);
  }

  @Post(['/api/calls/manual', '/api/tenants/:tenantId/calls/manual'])
  async manual(@Body() body: ManualCallDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const leadId = String(body.leadId ?? '').trim();
    if (!leadId) throw new BadRequestException('leadId é obrigatório');
    try { const result = await this.dialer.manualCall(leadId, tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'call.manual_started', entityType: 'lead', entityId: leadId, metadata: result }); return result; }
    catch (error) { throw new BadRequestException(String((error as Error).message ?? error)); }
  }

  @Post(['/api/calls/:id/outcome', '/api/tenants/:tenantId/calls/:id/outcome'])
  async outcome(@Param('id') id: string, @Body() body: OutcomeDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { const result = await this.dialer.recordOutcome(id, body.outcome, tenantId); await this.audit.record({ actorUserId: user.id, tenantId, action: 'call.outcome_recorded', entityType: 'call', entityId: id, metadata: { outcome: body.outcome } }); return result; }
}
