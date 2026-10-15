import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { ContactComplianceModule } from '../contact-compliance/contact-compliance.module';
import { CrmEventsModule } from '../crm-events/crm-events.module';
import { DialerModule } from '../dialer/dialer.module';
import { NumbersModule } from '../numbers/numbers.module';
import { UsersModule } from '../users/users.module';
import { CrmIntegrationsController } from './crm-integrations.controller';
import { CrmIntegrationsService } from './crm-integrations.service';
import { IntegrationKeyGuard } from './crm-integration.guard';
import { IntegrationAgentsService } from './integration-agents.service';
import { IntegrationApiController } from './integration-api.controller';
import { IntegrationCallsService } from './integration-calls.service';

@Module({
  imports: [AuditModule, BillingModule, ContactComplianceModule, CrmEventsModule, DialerModule, NumbersModule, UsersModule],
  controllers: [CrmIntegrationsController, IntegrationApiController],
  providers: [CrmIntegrationsService, IntegrationAgentsService, IntegrationCallsService, IntegrationKeyGuard],
  exports: [CrmIntegrationsService],
})
export class CrmIntegrationsModule {}
