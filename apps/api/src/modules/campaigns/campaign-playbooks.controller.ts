import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CreateCampaignPlaybookDto, InstantiateCampaignPlaybookDto } from './campaign-playbooks.dto';
import { CampaignsService } from './campaigns.service';

@Controller('/api/tenants/:tenantId')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('campaigns')
export class CampaignPlaybooksController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('campaign-playbooks')
  list(@CurrentTenant() tenantId: string) { return this.campaigns.listPlaybooks(tenantId); }

  @Post('campaigns/:campaignId/playbook')
  save(
    @CurrentTenant() tenantId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: any,
    @Body() input: CreateCampaignPlaybookDto,
  ) { return this.campaigns.savePlaybook(tenantId, campaignId, user.id, input); }

  @Post('campaign-playbooks/:playbookId/instantiate')
  instantiate(
    @CurrentTenant() tenantId: string,
    @Param('playbookId') playbookId: string,
    @CurrentUser() user: any,
    @Body() input: InstantiateCampaignPlaybookDto,
  ) { return this.campaigns.instantiatePlaybook(tenantId, playbookId, user.id, input); }
}
