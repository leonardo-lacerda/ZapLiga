import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { UsersService } from './users.service';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
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
}
