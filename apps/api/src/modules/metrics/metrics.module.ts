import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MetricsConsistencyService } from './metrics-consistency.service';
import { MetricsExportRepository } from './metrics-export.repository';
import { MetricsExportService } from './metrics-export.service';
import { MetricsGoalsRepository } from './metrics-goals.repository';
import { MetricsGoalsService } from './metrics-goals.service';
import { MetricsPerformanceInterceptor } from './metrics-performance.interceptor';
import { MetricsQueryGuardService } from './metrics-query-guard.service';
import { MetricsRetentionService } from './metrics-retention.service';
import { MetricsRollupService } from './metrics-rollup.service';
import { MetricsViewsRepository } from './metrics-views.repository';
import { MetricsViewsService } from './metrics-views.service';
import { MetricsController } from './metrics.controller';
import { MetricsRepository } from './metrics.repository';
import { MetricsService } from './metrics.service';

@Module({
  imports: [AuditModule],
  controllers: [MetricsController],
  providers: [
    MetricsService, MetricsRepository, MetricsConsistencyService, MetricsQueryGuardService,
    MetricsGoalsService, MetricsGoalsRepository,
    MetricsExportService, MetricsExportRepository,
    MetricsViewsService, MetricsViewsRepository,
    MetricsRollupService, MetricsRetentionService, MetricsPerformanceInterceptor,
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
