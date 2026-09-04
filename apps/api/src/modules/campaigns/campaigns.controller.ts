import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CampaignTransitionDto, CreateCampaignDto, DuplicateCampaignDto, UpdateCampaignDto } from './campaigns.dto';
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

  @Post()
  create(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: CreateCampaignDto) {
    return this.campaigns.create(tenantId, user.id, input);
  }

  @Patch(':campaignId')
  update(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: UpdateCampaignDto) {
    return this.campaigns.update(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/publish')
  publish(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: CampaignTransitionDto) {
    return this.campaigns.publish(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/start')
  start(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: CampaignTransitionDto) {
    return this.campaigns.start(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/pause')
  pause(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: CampaignTransitionDto) {
    return this.campaigns.pause(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/complete')
  complete(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: CampaignTransitionDto) {
    return this.campaigns.complete(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/archive')
  archive(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: CampaignTransitionDto) {
    return this.campaigns.archive(tenantId, campaignId, user.id, input);
  }

  @Post(':campaignId/duplicate')
  duplicate(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: DuplicateCampaignDto) {
    return this.campaigns.duplicate(tenantId, campaignId, user.id, input);
  }

  @Get(':campaignId/versions')
  versions(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string) {
    return this.campaigns.versions(tenantId, campaignId);
  }

  @Get(':campaignId/versions/:version')
  version(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @Param('version', ParseIntPipe) version: number) {
    return this.campaigns.version(tenantId, campaignId, version);
  }

  @Get(':campaignId/diff')
  diff(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @Query('from', ParseIntPipe) from: number, @Query('to', ParseIntPipe) to: number) {
    return this.campaigns.diff(tenantId, campaignId, from, to);
  }
}
