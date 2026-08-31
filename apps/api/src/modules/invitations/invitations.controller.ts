import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateSdrInvitationDto } from './dto/create-sdr-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InvitationsService } from './invitations.service';
import { AuthService } from '../auth/auth.service';
import { Response } from 'express';
import { Req, Res } from '@nestjs/common';

@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService, private readonly auth: AuthService) {}

  @Post('/api/tenants/:tenantId/sdrs/invitations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  createSdrInvitation(@Param('tenantId') tenantId: string, @Body() body: CreateSdrInvitationDto, @CurrentUser() user: any) {
    return this.invitations.createSdrInvitation(tenantId, user.id, body.email, body.name);
  }

  @Post('/api/tenants/:tenantId/sdrs/invitations/:invitationId/resend')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  resendSdrInvitation(@Param('tenantId') tenantId: string, @Param('invitationId') invitationId: string, @CurrentUser() user: any) {
    return this.invitations.resendSdrInvitation(tenantId, invitationId, user.id);
  }

  @Post('/api/tenants/:tenantId/invitations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  create(@Param('tenantId') tenantId: string, @Body() body: CreateInvitationDto, @CurrentUser() user: any) {
    return this.invitations.create(tenantId, user.id, body.email, body.role);
  }

  @Post('/api/tenants/:tenantId/invitations/:invitationId/resend')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  resend(@Param('tenantId') tenantId: string, @Param('invitationId') invitationId: string, @CurrentUser() user: any) { return this.invitations.resend(tenantId, invitationId, user.id); }

  @Get('/api/tenants/:tenantId/invitations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  list(@Param('tenantId') tenantId: string, @Query('role') role?: 'leader' | 'sdr', @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.invitations.list(tenantId, role, Number(limit), Number(offset)); }

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
