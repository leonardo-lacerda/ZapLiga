import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DecisionController } from './decision.controller';
import { DecisionPolicyService } from './decision-policy.service';
import { DecisionRepository } from './decision.repository';
import { DecisionShadowService } from './decision-shadow.service';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';

@Module({ imports: [AuditModule], controllers: [EligibilityController, DecisionController], providers: [EligibilityService, DecisionRepository, DecisionPolicyService, DecisionShadowService], exports: [EligibilityService, DecisionPolicyService, DecisionShadowService] })
export class DecisionEngineModule {}
