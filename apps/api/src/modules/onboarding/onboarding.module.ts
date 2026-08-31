import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({ imports: [AuditModule], controllers: [OnboardingController], providers: [OnboardingService] })
export class OnboardingModule {}
