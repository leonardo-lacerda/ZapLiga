import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { UpdateMembershipStatusDto } from './dto/update-membership-status.dto';
import { UpdateMembershipRoleDto } from './dto/update-membership-role.dto';
import { MembershipsService } from './memberships.service';

@Controller()
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService, private readonly audit: AuditService) {}

  @Get('/api/tenants/:tenantId/members')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  list(@Param('tenantId') tenantId: string) { return this.memberships.listForTenant(tenantId); }

  @Patch('/api/tenants/:tenantId/members/:userId/status')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  async status(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @Body() body: UpdateMembershipStatusDto, @CurrentUser() actor: any) {
    const target = await this.memberships.findByTenantAndUser(tenantId, userId);
    const actorMembership = actor.tenantMembership;
    if (actor.platformRole !== 'super_admin' && target.role === 'leader') throw new ForbiddenException('Líderes só podem ser administrados pelo Admin supremo');
    const membership = await this.memberships.setStatus(tenantId, userId, body.status);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: `membership.${body.status}`, entityType: 'membership', entityId: target.id, metadata: { userId, role: target.role, actorRole: actorMembership?.role ?? actor.platformRole } });
    return membership;
  }

  @Delete('/api/tenants/:tenantId/members/:userId')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  async remove(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @CurrentUser() actor: any) {
    const target = await this.memberships.findByTenantAndUser(tenantId, userId);
    if (actor.platformRole !== 'super_admin' && target.role === 'leader') throw new ForbiddenException('Líderes só podem ser administrados pelo Admin supremo');
    const membership = await this.memberships.remove(tenantId, userId);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'membership.removed', entityType: 'membership', entityId: target.id, metadata: { userId, role: target.role } });
    return membership;
  }

  @Patch('/api/tenants/:tenantId/members/:userId/role')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('super_admin')
  async role(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @Body() body: UpdateMembershipRoleDto, @CurrentUser() actor: any) {
    const target = await this.memberships.findByTenantAndUser(tenantId, userId);
    const membership = await this.memberships.setRole(tenantId, userId, body.role);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'membership.role_changed', entityType: 'membership', entityId: target.id, metadata: { userId, from: target.role, to: body.role } });
    return membership;
  }
}
