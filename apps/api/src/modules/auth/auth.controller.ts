import { Body, Controller, Delete, Get, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from './auth.guards';
import { LoginDto } from './dto/login.dto';
import { RegisterOrganizerDto } from './dto/register-organizer.dto';
import { AuthService } from './auth.service';
import { AccountSwitcherService } from './account-switcher.service';
import { AddAccountDto } from './dto/add-account.dto';
import { ForgotPasswordDto, ResendVerificationDto, ResetPasswordDto, TokenDto } from './dto/account-lifecycle.dto';

@Controller('/api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly accounts: AccountSwitcherService) {}

  @Post('/login')
  async login(@Body() body: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body.email, body.password, request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    return this.auth.publicResponse(result);
  }

  @Post('/register')
  async register(@Body() body: RegisterOrganizerDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const defaultEnabled = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    if ((process.env.PUBLIC_REGISTRATION_ENABLED ?? String(defaultEnabled)) !== 'true') throw new ServiceUnavailableException({ code: 'public_registration_disabled', message: 'Cadastro publico ainda nao foi habilitado' });
    const result = await this.auth.registerOrganizer(body, request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    return this.auth.publicResponse(result);
  }

  @Post('/refresh')
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.refresh(request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    return this.auth.publicResponse(result);
  }

  @Post('/password/forgot') forgotPassword(@Body() body: ForgotPasswordDto, @Req() request: Request) { return this.auth.forgotPassword(body.email, request); }
  @Post('/password/reset') resetPassword(@Body() body: ResetPasswordDto, @Req() request: Request) { return this.auth.resetPassword(body.token, body.password, request); }
  @Post('/email/verify') verifyEmail(@Body() body: TokenDto, @Req() request: Request) { return this.auth.verifyEmail(body.token, request); }
  @Post('/email/resend-verification') resendVerification(@Body() body: ResendVerificationDto, @Req() request: Request) { return this.auth.resendVerification(body.email, request); }
  @Get('/legal-documents') legalDocuments() { return this.auth.legalDocuments(); }

  @Get('/accounts')
  @UseGuards(AuthGuard)
  listAccounts(@CurrentUser() user: any, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.accounts.list(user.id, request, response);
  }

  @Post('/accounts/add')
  @UseGuards(AuthGuard)
  async addAccount(@Body() body: AddAccountDto, @CurrentUser() user: any, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.accounts.add(user.id, body.email, body.password, request, response);
    return result;
  }

  @Post('/accounts/:accountId/switch')
  @UseGuards(AuthGuard)
  async switchAccount(@Param('accountId') accountId: string, @CurrentUser() user: any, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.accounts.switch(user.id, accountId, request, response);
  }

  @Delete('/accounts/:accountId')
  @UseGuards(AuthGuard)
  unlinkAccount(@Param('accountId') accountId: string, @CurrentUser() user: any, @Req() request: Request) {
    return this.accounts.remove(user.id, accountId, request);
  }

  @Post('/logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request);
    this.auth.clearRefreshCookie(response);
    return { ok: true };
  }

  @Post('/logout-all')
  @UseGuards(AuthGuard)
  async logoutAll(@CurrentUser() user: any, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logoutAll(user.id, request);
    this.auth.clearRefreshCookie(response);
    return { ok: true };
  }

  @Get('/me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: any) { return this.auth.me(user.id); }

  @Post('/ws-ticket')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('sdr')
  websocketTicket(@CurrentUser() user: any) {
    return this.auth.createWebsocketTicket(user.id, user.tenantMembership.tenantId);
  }

  @Post('/operations-ws-ticket')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
  @Roles('leader', 'super_admin')
  operationsWebsocketTicket(@CurrentUser() user: any) {
    return this.auth.createWebsocketTicket(user.id, user.tenantMembership.tenantId);
  }

}
