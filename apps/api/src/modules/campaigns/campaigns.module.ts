import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsRepository } from './campaigns.repository';
import { CampaignsService } from './campaigns.service';
import { CampaignExecutionService } from './campaign-execution.service';
import { CampaignEventsService } from './campaign-events.service';
import { CampaignPlaybooksController } from './campaign-playbooks.controller';

@Module({
  imports: [AuditModule],
  controllers: [CampaignsController, CampaignPlaybooksController],
  providers: [CampaignsRepository, CampaignsService, CampaignExecutionService, CampaignEventsService],
  exports: [CampaignsService, CampaignExecutionService, CampaignEventsService],
})
export class CampaignsModule {}
