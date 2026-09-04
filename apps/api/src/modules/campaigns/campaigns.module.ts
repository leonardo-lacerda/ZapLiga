import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsRepository } from './campaigns.repository';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [AuditModule],
  controllers: [CampaignsController],
  providers: [CampaignsRepository, CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
