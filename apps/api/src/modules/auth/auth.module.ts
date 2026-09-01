import { forwardRef, Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthGuard, RolesGuard, TenantMembershipGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AccountMailer } from './account-mailer';
import { AccountController } from './account.controller';
import { AccountSwitcherService } from './account-switcher.service';

@Global()
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET ?? 'dev-only-change-this-secret' }), RedisModule, forwardRef(() => UsersModule), forwardRef(() => AuditModule)],
  controllers: [AuthController, AccountController],
  providers: [AuthService, AccountSwitcherService, AuthGuard, RolesGuard, TenantMembershipGuard, AccountMailer],
  exports: [AuthService, AuthGuard, RolesGuard, TenantMembershipGuard],
})
export class AuthModule {}
