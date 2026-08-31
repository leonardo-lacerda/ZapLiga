import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { CallbacksService } from './callbacks.service';
import { BulkReassignCallbacksDto, CancelCallbackDto, ReassignCallbackDto, RescheduleCallbackDto } from './dto/callback-action.dto';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('callbacks')
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}
  private isSdr(user: any) { return user.platformRole !== 'super_admin' && user.tenantMembership?.role === 'sdr'; }
  @Get(['/api/callbacks', '/api/tenants/:tenantId/callbacks']) @Roles('leader', 'super_admin', 'sdr') async list(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Query('assignedSdrId') assignedSdrId?: string, @Query('status') status?: string) { const own = this.isSdr(user) ? await this.callbacks.sdrIdForUser(tenantId, user.id) : undefined; return this.callbacks.list(tenantId, { assignedSdrId, status, userSdrId: own }); }
  @Patch(['/api/callbacks/:id/reschedule', '/api/tenants/:tenantId/callbacks/:id/reschedule']) @Roles('leader', 'super_admin', 'sdr') async reschedule(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string, @Body() body: RescheduleCallbackDto) { const own = this.isSdr(user) ? await this.callbacks.sdrIdForUser(tenantId, user.id) : undefined; return this.callbacks.reschedule(tenantId, id, body.dueAt, body.notes, user.id, own); }
  @Patch(['/api/callbacks/:id/reassign', '/api/tenants/:tenantId/callbacks/:id/reassign']) @Roles('leader', 'super_admin') reassign(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string, @Body() body: ReassignCallbackDto) { return this.callbacks.reassign(tenantId, [id], body.assignedSdrId, user.id).then((rows) => rows[0] ?? { ok: true }); }
  @Patch(['/api/callbacks/reassign', '/api/tenants/:tenantId/callbacks/reassign']) @Roles('leader', 'super_admin') bulkReassign(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: BulkReassignCallbacksDto) { return this.callbacks.reassign(tenantId, body.callbackIds, body.assignedSdrId, user.id); }
  @Post(['/api/callbacks/:id/cancel', '/api/tenants/:tenantId/callbacks/:id/cancel']) @Roles('leader', 'super_admin', 'sdr') async cancel(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string, @Body() body: CancelCallbackDto) { const own = this.isSdr(user) ? await this.callbacks.sdrIdForUser(tenantId, user.id) : undefined; return this.callbacks.cancel(tenantId, id, body.reason, body.status ?? 'cancelled', user.id, own); }
  @Post(['/api/callbacks/:id/call', '/api/tenants/:tenantId/callbacks/:id/call']) @Roles('leader', 'super_admin', 'sdr') call(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.callbacks.callNow(tenantId, id, user.id, this.isSdr(user) ? user.id : undefined); }
}
