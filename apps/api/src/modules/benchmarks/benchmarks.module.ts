import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { BenchmarkAdminController, BenchmarksController } from './benchmarks.controller';
import { BenchmarksService } from './benchmarks.service';

@Module({ imports: [AuditModule, FeatureFlagsModule], controllers: [BenchmarksController, BenchmarkAdminController], providers: [BenchmarksService], exports: [BenchmarksService] })
export class BenchmarksModule {}
