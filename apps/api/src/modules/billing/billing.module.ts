import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StripeModule } from '../../infrastructure/stripe/stripe.module';
import { BillingAdminController, BillingController, BillingWebhookController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingWorkerService } from './billing-worker.service';
import { EntitlementService } from './entitlement.service';
import { SdrCapacityService } from './sdr-capacity.service';
import { PlanLimitsService } from './plan-limits.service';

@Module({
  imports: [AuditModule, StripeModule],
  controllers: [BillingController, BillingWebhookController, BillingAdminController],
  providers: [BillingService, EntitlementService, BillingWorkerService, SdrCapacityService, PlanLimitsService],
  exports: [BillingService, EntitlementService, SdrCapacityService, PlanLimitsService],
})
export class BillingModule {}
