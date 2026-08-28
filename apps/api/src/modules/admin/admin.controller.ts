import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, Roles, RolesGuard } from '../auth/auth.guards';
import { AdminService } from './admin.service';

@Controller('/api/admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly audit: AuditService) {}

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
  async revokeTenantSessions(@Param('tenantId') tenantId: string, @Body() body: { reason?: string }, @CurrentUser() actor: any) {
    const result = await this.admin.revokeTenantSessions(tenantId);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'tenant.sessions_revoked', entityType: 'tenant', entityId: tenantId, metadata: { reason: body?.reason ?? null, revoked: result.revoked } });
    return result;
  }
}
