import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { BillingModule } from '../billing/billing.module';
import { LeadIngestionController } from './lead-ingestion.controller';
import { LeadIngestionService } from './lead-ingestion.service';

@Module({ imports: [AuditModule, CampaignsModule, BillingModule], controllers: [LeadIngestionController], providers: [LeadIngestionService], exports: [LeadIngestionService] })
export class LeadIngestionModule {}
