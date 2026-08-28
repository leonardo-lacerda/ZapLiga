import { forwardRef, Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { RedisModule } from '../../infrastructure/redis/redis.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthGuard, RolesGuard, TenantMembershipGuard } from './auth.guards';
import { AuthService } from './auth.service';

@Global()
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_ACCESS_SECRET ?? 'dev-only-change-this-secret' }), RedisModule, forwardRef(() => UsersModule), forwardRef(() => AuditModule)],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, RolesGuard, TenantMembershipGuard],
  exports: [AuthService, AuthGuard, RolesGuard, TenantMembershipGuard],
})
export class AuthModule {}
