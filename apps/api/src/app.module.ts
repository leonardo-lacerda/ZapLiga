import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { CallsController } from './modules/calls/calls.controller';
import { DialerController } from './modules/dialer/dialer.controller';
import { DialerModule } from './modules/dialer/dialer.module';
import { LeadsController } from './modules/leads/leads.controller';
import { HealthController } from './modules/health/health.controller';
import { NumbersController } from './modules/numbers/numbers.controller';
import { SdrsController } from './modules/sdrs/sdrs.controller';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { AdminModule } from './modules/admin/admin.module';
import { LeadFoldersModule } from './modules/lead-folders/lead-folders.module';
import { MetricsModule } from './modules/metrics/metrics.module';

@Module({
  imports: [DatabaseModule, RedisModule, AuthModule, AuditModule, InvitationsModule, MembershipsModule, TenantsModule, UsersModule, DialerModule, AdminModule, LeadFoldersModule, MetricsModule],
  controllers: [CallsController, DialerController, HealthController, LeadsController, NumbersController, SdrsController],
})
export class AppModule {}
