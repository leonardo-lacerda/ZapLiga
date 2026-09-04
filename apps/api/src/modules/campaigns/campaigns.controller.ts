import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CampaignsService } from './campaigns.service';

@Controller('/api/tenants/:tenantId/campaigns')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.campaigns.list(tenantId, { status, limit, offset });
  }

  @Get(':campaignId')
  get(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string) {
    return this.campaigns.get(tenantId, campaignId);
  }
}
