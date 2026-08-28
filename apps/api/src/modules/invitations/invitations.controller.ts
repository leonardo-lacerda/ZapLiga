import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InvitationsService } from './invitations.service';
import { AuthService } from '../auth/auth.service';
import { Response } from 'express';
import { Req, Res } from '@nestjs/common';

@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService, private readonly auth: AuthService) {}

  @Post('/api/tenants/:tenantId/invitations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  create(@Param('tenantId') tenantId: string, @Body() body: CreateInvitationDto, @CurrentUser() user: any) {
    if (user.platformRole !== 'super_admin' && body.role === 'leader') throw new ForbiddenException('Somente o Admin supremo pode convidar líderes');
    return this.invitations.create(tenantId, user.id, body.email, body.role);
  }

  @Get('/api/tenants/:tenantId/invitations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  list(@Param('tenantId') tenantId: string) { return this.invitations.list(tenantId); }

  @Get('/api/invitations/:token')
  preview(@Param('token') token: string) { return this.invitations.preview(token); }

  @Post('/api/invitations/:token/accept')
  async accept(@Param('token') token: string, @Body() body: AcceptInvitationDto, @Req() request: any, @Res({ passthrough: true }) response: Response) {
    const accepted = await this.invitations.accept(token, body.name, body.password);
    const authResult = await this.auth.createSessionForUser(accepted.user.id, request);
    this.auth.setRefreshCookie(response, authResult._refreshToken);
    const { _refreshToken: _ignoredToken, ...safe } = this.auth.publicResponse(authResult);
    return { ...safe, tenant: { id: accepted.invitation.tenant_id, name: accepted.invitation.tenant_name, role: accepted.membership.role } };
  }

  @Delete('/api/tenants/:tenantId/invitations/:invitationId')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  revoke(@Param('tenantId') tenantId: string, @Param('invitationId') invitationId: string, @CurrentUser() user: any) { return this.invitations.revoke(tenantId, invitationId, user.id); }
}
