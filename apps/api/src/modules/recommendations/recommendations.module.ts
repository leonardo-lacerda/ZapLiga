import { Module } from '@nestjs/common';
import { AnalyticsEventsModule } from '../analytics-events/analytics-events.module';
import { AuditModule } from '../audit/audit.module';
import { DialerScheduleModule } from '../dialer-schedule/dialer-schedule.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsRepository } from './recommendations.repository';
import { RecommendationsService } from './recommendations.service';

@Module({ imports: [AuditModule, DialerScheduleModule, MetricsModule, AnalyticsEventsModule], controllers: [RecommendationsController], providers: [RecommendationsRepository, RecommendationsService], exports: [RecommendationsService] })
export class RecommendationsModule {}
