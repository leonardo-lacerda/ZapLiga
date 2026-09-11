import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { DialerService } from '../dialer/dialer.service';
import { AdminService } from './admin.service';

@Controller('/api/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly audit: AuditService, private readonly dialer: DialerService) {}

  @Get('/overview')
  overview(@Query('tenantId') tenantId?: string) { return this.admin.overview(tenantId); }

  @Get('/tenants')
  tenants(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) { return this.admin.listTenants({ search, status, limit: Number(limit), offset: Number(offset) }); }

  @Get('/tenants/:tenantId/summary')
  tenantSummary(@Param('tenantId') tenantId: string) { return this.admin.tenantSummary(tenantId); }

  @Get('/users')
  users(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('role') role?: string,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) { return this.admin.listUsers({ search, status, role, tenantId, limit: Number(limit), offset: Number(offset) }); }

  @Get('/operations')
  operations(@Query('tenantId') tenantId?: string) { return this.admin.operations(tenantId); }

  @Get('/health')
  health() { return this.admin.health(); }

  @Post('/users/:userId/revoke-sessions')
  async revokeUserSessions(@Param('userId') userId: string, @Body() body: { reason?: string }, @CurrentUser() actor: any) {
    const result = await this.admin.revokeUserSessions(userId);
    await this.audit.record({ actorUserId: actor.id, action: 'user.sessions_revoked', entityType: 'user', entityId: userId, metadata: { reason: body?.reason ?? null, revoked: result.revoked } });
    return result;
  }

  @Post('/tenants/:tenantId/revoke-sessions')
  @UseGuards(TenantMembershipGuard)
  @TenantAction('read')
  async revokeTenantSessions(@Param('tenantId') tenantId: string, @Body() body: { reason?: string; role?: 'leader' | 'sdr' }, @CurrentUser() actor: any) {
    const role = body?.role === 'leader' || body?.role === 'sdr' ? body.role : undefined;
    const result = await this.admin.revokeTenantSessions(tenantId, role);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'tenant.sessions_revoked', entityType: 'tenant', entityId: tenantId, metadata: { reason: body?.reason ?? null, role: role ?? 'all', revoked: result.revoked } });
    return result;
  }

  // --- Números WhatsApp (funciona mesmo com a empresa bloqueada/arquivada) ---

  @Get('/tenants/:tenantId/numbers')
  @UseGuards(TenantMembershipGuard)
  tenantNumbers(@Param('tenantId') tenantId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.admin.tenantNumbers(tenantId, { limit: Number(limit), offset: Number(offset) });
  }

  @Post('/tenants/:tenantId/numbers/:numberId/clear-quarantine')
  @UseGuards(TenantMembershipGuard)
  async clearNumberQuarantine(@Param('tenantId') tenantId: string, @Param('numberId') numberId: string, @Body() body: { reason?: string }, @CurrentUser() actor: any) {
    const result = await this.admin.clearNumberQuarantine(tenantId, numberId);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'number.quarantine_cleared', entityType: 'whatsapp_number', entityId: numberId, metadata: { reason: body?.reason ?? null } });
    return result;
  }

  @Post('/tenants/:tenantId/numbers/:numberId/clear-cooldown')
  @UseGuards(TenantMembershipGuard)
  async clearNumberCooldown(@Param('tenantId') tenantId: string, @Param('numberId') numberId: string, @Body() body: { reason?: string }, @CurrentUser() actor: any) {
    const result = await this.admin.clearNumberCooldown(tenantId, numberId);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'number.cooldown_cleared', entityType: 'whatsapp_number', entityId: numberId, metadata: { reason: body?.reason ?? null } });
    return result;
  }

  // --- Break-glass: chamadas e SDRs travados ---

  @Post('/tenants/:tenantId/calls/:callId/force-finish')
  @UseGuards(TenantMembershipGuard)
  @TenantAction('call_finalize')
  async forceFinishCall(@Param('tenantId') tenantId: string, @Param('callId') callId: string, @Body() body: { reason?: string; confirmActiveOwner?: boolean }, @CurrentUser() actor: any) {
    const result = await this.dialer.adminForceFinishCall(callId, tenantId, Boolean(body?.confirmActiveOwner));
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'call.admin_force_finished', entityType: 'call', entityId: callId, metadata: { reason: body?.reason ?? null, ownerAlive: result.ownerAlive } });
    return result;
  }

  @Post('/tenants/:tenantId/sdrs/:sdrId/force-available')
  @UseGuards(TenantMembershipGuard)
  @TenantAction('call_finalize')
  async forceReleaseSdr(@Param('tenantId') tenantId: string, @Param('sdrId') sdrId: string, @Body() body: { reason?: string; confirmActiveOwner?: boolean }, @CurrentUser() actor: any) {
    const result = await this.dialer.adminForceReleaseSdr(sdrId, tenantId, Boolean(body?.confirmActiveOwner));
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'sdr.admin_force_available', entityType: 'sdr', entityId: sdrId, metadata: { reason: body?.reason ?? null, hadActiveCall: result.hadActiveCall, hadOpenPause: result.hadOpenPause } });
    return result;
  }

  // --- Notas internas ---

  @Post('/tenants/:tenantId/notes')
  @UseGuards(TenantMembershipGuard)
  async addTenantNote(@Param('tenantId') tenantId: string, @Body() body: { body?: string; pinned?: boolean }, @CurrentUser() actor: any) {
    const note = await this.admin.addTenantNote(tenantId, actor.id, String(body?.body ?? ''), Boolean(body?.pinned));
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'tenant.note_added', entityType: 'tenant', entityId: tenantId, metadata: { preview: String(body?.body ?? '').slice(0, 140) } });
    return note;
  }

  @Delete('/tenants/:tenantId/notes/:noteId')
  @UseGuards(TenantMembershipGuard)
  async removeTenantNote(@Param('tenantId') tenantId: string, @Param('noteId') noteId: string, @CurrentUser() actor: any) {
    const result = await this.admin.removeTenantNote(tenantId, noteId);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'tenant.note_removed', entityType: 'tenant', entityId: tenantId, metadata: { noteId } });
    return result;
  }

  // --- Segurança em massa ---

  @Post('/tenants/:tenantId/leaders/reset-passwords')
  @UseGuards(TenantMembershipGuard)
  @TenantAction('read')
  async bulkResetLeaderPasswords(@Param('tenantId') tenantId: string, @CurrentUser() actor: any) {
    const results = await this.admin.bulkResetLeaderPasswords(tenantId);
    await Promise.all(results.map((entry) => this.audit.record({ actorUserId: actor.id, tenantId, action: 'user.password_reset', entityType: 'user', entityId: entry.userId })));
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'tenant.leaders_passwords_reset', entityType: 'tenant', entityId: tenantId, metadata: { count: results.length, userIds: results.map((entry) => entry.userId) } });
    return results;
  }
}
