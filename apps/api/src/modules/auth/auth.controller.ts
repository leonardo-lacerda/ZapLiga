import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from './auth.guards';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './auth.service';

@Controller('/api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('/login')
  async login(@Body() body: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body.email, body.password, request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    return this.auth.publicResponse(result);
  }

  @Post('/refresh')
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.refresh(request);
    this.auth.setRefreshCookie(response, result._refreshToken);
    return this.auth.publicResponse(result);
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

}
