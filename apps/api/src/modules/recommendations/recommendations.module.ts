import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsRepository } from './recommendations.repository';
import { RecommendationsService } from './recommendations.service';

@Module({ imports: [AuditModule, MetricsModule], controllers: [RecommendationsController], providers: [RecommendationsRepository, RecommendationsService], exports: [RecommendationsService] })
export class RecommendationsModule {}
