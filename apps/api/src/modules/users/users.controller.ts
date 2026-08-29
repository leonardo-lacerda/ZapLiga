import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { UsersService } from './users.service';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdatePlatformRoleDto } from './dto/update-platform-role.dto';
import { AuditService } from '../audit/audit.service';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService, private readonly audit: AuditService) {}

  @Get('/api/users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  list() { return this.users.listAll(); }

  @Get('/api/users/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async get(@Param('id') id: string) { return this.users.sanitize(await this.users.requireById(id)); }

  @Patch('/api/users/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async status(@Param('id') id: string, @Body() body: UpdateUserStatusDto, @CurrentUser() actor: any) {
    const user = await this.users.setStatus(id, body.status);
    await this.audit.record({ actorUserId: actor.id, action: `user.${body.status}`, entityType: 'user', entityId: id });
    return this.users.sanitize(user);
  }

  @Patch('/api/users/:id/platform-role')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async platformRole(@Param('id') id: string, @Body() body: UpdatePlatformRoleDto, @CurrentUser() actor: any) {
    if (actor.id === id) throw new ForbiddenException('Você não pode alterar seu próprio nível de acesso');
    const user = await this.users.setPlatformRole(id, body.platformRole);
    await this.audit.record({ actorUserId: actor.id, action: 'user.platform_role_changed', entityType: 'user', entityId: id, metadata: { platformRole: body.platformRole } });
    return this.users.sanitize(user);
  }

  @Post('/api/users/:id/reset-password')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('super_admin')
  async resetPassword(@Param('id') id: string, @CurrentUser() actor: any) {
    const { user, temporaryPassword } = await this.users.resetPassword(id);
    await this.audit.record({ actorUserId: actor.id, action: 'user.password_reset', entityType: 'user', entityId: id });
    return { user: this.users.sanitize(user), temporaryPassword };
  }
}
