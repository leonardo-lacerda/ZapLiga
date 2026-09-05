import { Module } from '@nestjs/common';
import { AnalyticsEventsModule } from '../analytics-events/analytics-events.module';
import { AuditModule } from '../audit/audit.module';
import { DialerScheduleModule } from '../dialer-schedule/dialer-schedule.module';
import { NumberHealthService } from './number-health.service';
import { OperationHealthController } from './operation-health.controller';
import { OperationHealthService } from './operation-health.service';
import { HealthRecommendationsAdapter } from './health-recommendations.adapter';

@Module({
  imports: [AuditModule, DialerScheduleModule, AnalyticsEventsModule],
  controllers: [OperationHealthController],
  providers: [OperationHealthService, NumberHealthService, HealthRecommendationsAdapter],
  exports: [OperationHealthService, NumberHealthService],
})
export class OperationHealthModule {}
