import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { UsersService } from '../users/users.service';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdateMembershipStatusDto } from './dto/update-membership-status.dto';
import { UpdateMembershipRoleDto } from './dto/update-membership-role.dto';
import { MembershipsService } from './memberships.service';

@Controller()
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService, private readonly audit: AuditService, private readonly users: UsersService) {}

  @Get('/api/tenants/:tenantId/members')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  list(@Param('tenantId') tenantId: string, @Query('role') role?: 'leader' | 'sdr', @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.memberships.listForTenant(tenantId, role, Number(limit), Number(offset)); }

  @Post('/api/tenants/:tenantId/members')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  async create(@Param('tenantId') tenantId: string, @Body() body: CreateMembershipDto, @CurrentUser() actor: any) {
    if (actor.platformRole !== 'super_admin' && body.role === 'leader') throw new ForbiddenException('Líderes só podem ser adicionados pelo Admin supremo');
    const user = await this.users.findByEmail(body.email);
    if (!user) throw new NotFoundException('Nenhuma conta encontrada com este e-mail. Use um convite para criar uma conta nova.');
    const membership = await this.memberships.create(tenantId, user.id, body.role);
    await this.audit.record({ actorUserId: actor.id, tenantId, action: 'membership.created', entityType: 'membership', entityId: membership.id, metadata: { userId: user.id, role: body.role } });
    return membership;
  }

  @Patch('/api/tenants/:tenantId/members/:userId/status')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  async status(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @Body() body: UpdateMembershipStatusDto, @CurrentUser() actor: any) {
    const target = await this.memberships.findByTenantAndUser(tenantId, userId);
    const actorMembership = actor.tenantMembership;
    if (actor.platformRole !== 'super_admin' && target.role === 'leader') throw new ForbiddenException('Líderes só podem ser administrados pelo Admin supremo');
    const membership = await this.memberships.setStatus(tenantId, userId, body.status);
    const action = target.role === 'sdr' ? body.status === 'active' ? 'sdr.activated' : body.status === 'blocked' ? 'sdr.blocked' : 'sdr.removed' : `membership.${body.status}`;
    await this.audit.record({ actorUserId: actor.id, tenantId, action, entityType: 'membership', entityId: target.id, metadata: { userId, role: target.role, actorRole: actorMembership?.role ?? actor.platformRole } });
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
