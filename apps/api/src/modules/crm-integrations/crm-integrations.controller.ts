import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CreateCrmIntegrationDto } from './dto/crm-integration.dto';
import { CrmIntegrationsService } from './crm-integrations.service';

/** Panel routes: a leader generates, rotates and revokes the CRM's API key. */
@Controller('/api/tenants/:tenantId/crm-integrations')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('crm_integration')
@Roles('leader', 'super_admin')
export class CrmIntegrationsController {
  constructor(private readonly integrations: CrmIntegrationsService) {}

  @Get()
  list(@CurrentTenant() tenantId: string) { return this.integrations.list(tenantId); }

  @Post()
  create(@Body() body: CreateCrmIntegrationDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.integrations.create(tenantId, user.id, body); }

  @Post('/:id/rotate')
  rotate(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.integrations.rotate(tenantId, user.id, id); }

  @Post('/:id/revoke')
  revoke(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.integrations.revoke(tenantId, user.id, id); }

  @Get('/:id/events')
  events(@Param('id') id: string, @Query('status') status: string | undefined, @Query('limit') limit: string | undefined, @CurrentTenant() tenantId: string) { return this.integrations.listEvents(tenantId, id, { status, limit: Number(limit) }); }

  @Post('/:id/events/:eventId/retry')
  retryEvent(@Param('id') id: string, @Param('eventId') eventId: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.integrations.retryEvent(tenantId, user.id, id, eventId); }
}
