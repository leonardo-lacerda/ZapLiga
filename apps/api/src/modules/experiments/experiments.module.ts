import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { ExperimentsController } from './experiments.controller';
import { ExperimentsService } from './experiments.service';

@Module({ imports: [AuditModule, FeatureFlagsModule], controllers: [ExperimentsController], providers: [ExperimentsService], exports: [ExperimentsService] })
export class ExperimentsModule {}
