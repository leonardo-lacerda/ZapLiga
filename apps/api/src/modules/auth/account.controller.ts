import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard, CurrentUser } from './auth.guards';
import { AuthService } from './auth.service';
import { ChangePasswordDto, UpdateProfileDto } from './dto/account-lifecycle.dto';

@Controller('/api/me')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly auth: AuthService) {}
  @Patch('/profile') updateProfile(@CurrentUser() user: any, @Body() body: UpdateProfileDto, @Req() request: Request) { return this.auth.updateProfile(user.id, body.name, request); }
  @Patch('/password') changePassword(@CurrentUser() user: any, @Body() body: ChangePasswordDto, @Req() request: Request) { return this.auth.changePassword(user.id, user.sessionId, body.currentPassword, body.newPassword, request); }
  @Get('/sessions') sessions(@CurrentUser() user: any) { return this.auth.listSessions(user.id, user.sessionId); }
  @Delete('/sessions/:sessionId') revoke(@CurrentUser() user: any, @Param('sessionId') sessionId: string, @Req() request: Request) { return this.auth.revokeSession(user.id, sessionId, request); }
  @Post('/legal-acceptance') acceptLegal(@CurrentUser() user: any, @Req() request: Request) { return this.auth.acceptCurrentLegalDocuments(user.id, request); }
}
