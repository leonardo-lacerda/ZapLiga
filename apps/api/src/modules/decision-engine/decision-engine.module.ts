import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';

@Module({ imports: [AuditModule], controllers: [EligibilityController], providers: [EligibilityService], exports: [EligibilityService] })
export class DecisionEngineModule {}
