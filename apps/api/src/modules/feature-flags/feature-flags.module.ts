import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagGuard } from './feature-flags.guard';
import { FeatureFlagsService } from './feature-flags.service';

@Global()
@Module({ imports: [AuditModule], controllers: [FeatureFlagsController], providers: [FeatureFlagsService, FeatureFlagGuard], exports: [FeatureFlagsService, FeatureFlagGuard] })
export class FeatureFlagsModule {}
