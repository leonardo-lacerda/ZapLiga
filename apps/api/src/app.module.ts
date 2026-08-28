import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { WaxumClient } from './infrastructure/waxum/waxum.client';
import { CallsController } from './modules/calls/calls.controller';
import { DialerController } from './modules/dialer/dialer.controller';
import { DialerService } from './modules/dialer/dialer.service';
import { LeadsController } from './modules/leads/leads.controller';
import { HealthController } from './modules/health/health.controller';
import { NumbersController } from './modules/numbers/numbers.controller';
import { SdrGateway } from './modules/sdrs/sdr.gateway';
import { SdrsController } from './modules/sdrs/sdrs.controller';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [DatabaseModule, RedisModule, AuthModule, AuditModule, InvitationsModule, MembershipsModule, TenantsModule, UsersModule],
  controllers: [CallsController, DialerController, HealthController, LeadsController, NumbersController, SdrsController],
  providers: [WaxumClient, DialerService, SdrGateway],
  exports: [DialerService, SdrGateway],
})
export class AppModule {}
