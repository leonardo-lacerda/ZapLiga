import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
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
import { ContactComplianceModule } from './modules/contact-compliance/contact-compliance.module';
import { DialerScheduleModule } from './modules/dialer-schedule/dialer-schedule.module';
import { CallbacksModule } from './modules/callbacks/callbacks.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { OperationalMetricsInterceptor } from './infrastructure/operational-metrics.interceptor';
import { LeadIngestionModule } from './modules/lead-ingestion/lead-ingestion.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';

@Module({
  imports: [DatabaseModule, RedisModule, FeatureFlagsModule, AuthModule, AuditModule, InvitationsModule, MembershipsModule, TenantsModule, UsersModule, ContactComplianceModule, DialerScheduleModule, DialerModule, CallbacksModule, OnboardingModule, PrivacyModule, AdminModule, LeadFoldersModule, MetricsModule, LeadIngestionModule, CampaignsModule, RecommendationsModule],
  controllers: [CallsController, DialerController, HealthController, LeadsController, NumbersController, SdrsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: OperationalMetricsInterceptor }],
})
export class AppModule {}
