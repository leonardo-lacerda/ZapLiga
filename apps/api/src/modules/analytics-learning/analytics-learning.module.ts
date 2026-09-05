import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AnalyticsLearningController } from './analytics-learning.controller';
import { AnalyticsLearningService } from './analytics-learning.service';

@Module({ imports: [AuditModule, FeatureFlagsModule], controllers: [AnalyticsLearningController], providers: [AnalyticsLearningService], exports: [AnalyticsLearningService] })
export class AnalyticsLearningModule {}
