import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CreateLeadIntegrationDto } from './dto/create-lead-integration.dto';
import { UpdateLeadIntegrationDto } from './dto/update-lead-integration.dto';
import { LeadIngestionService } from './lead-ingestion.service';

@Controller()
export class LeadIngestionController {
  constructor(private readonly ingestion: LeadIngestionService) {}

  @Post('/api/v1/lead-integrations/:publicId/leads')
  @HttpCode(HttpStatus.ACCEPTED)
  accept(@Param('publicId') publicId: string, @Req() request: any) { return this.ingestion.accept(publicId, request, false); }

  @Post('/api/v1/lead-integrations/:publicId/webhook')
  @HttpCode(HttpStatus.ACCEPTED)
  webhook(@Param('publicId') publicId: string, @Req() request: any) { return this.ingestion.accept(publicId, request, false); }

  @Post('/api/v1/lead-integrations/:publicId/leads/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  batch(@Param('publicId') publicId: string, @Req() request: any) { return this.ingestion.accept(publicId, request, true); }

  @Get('/api/tenants/:tenantId/lead-integrations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  list(@CurrentTenant() tenantId: string) { return this.ingestion.list(tenantId); }

  @Post('/api/tenants/:tenantId/lead-integrations')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  create(@Body() body: CreateLeadIntegrationDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.ingestion.create(tenantId, user.id, body); }

  @Patch('/api/tenants/:tenantId/lead-integrations/:id')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  update(@Param('id') id: string, @Body() body: UpdateLeadIntegrationDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.ingestion.update(tenantId, user.id, id, body); }

  @Post('/api/tenants/:tenantId/lead-integrations/:id/revoke')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  revoke(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.ingestion.revoke(tenantId, user.id, id); }

  @Post('/api/tenants/:tenantId/lead-integrations/:id/rotate-secret')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  rotate(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.ingestion.rotate(tenantId, user.id, id); }

  @Get('/api/tenants/:tenantId/lead-ingestion/events')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  events(@Query('limit') limit: string, @Query('offset') offset: string, @CurrentTenant() tenantId: string) { return this.ingestion.listEvents(tenantId, Number(limit), Number(offset)); }

  @Get('/api/tenants/:tenantId/lead-ingestion/events/:id')
  @UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
  @RequiresFeature('lead_ingestion_api')
  @Roles('leader', 'super_admin')
  event(@Param('id') id: string, @CurrentTenant() tenantId: string) { return this.ingestion.getEvent(tenantId, id); }
}
