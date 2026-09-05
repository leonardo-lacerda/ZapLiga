import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { OutboundWebhooksService } from './outbound-webhooks.service';

@Controller('/api/tenants/:tenantId/outbound-webhooks')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('analytics_learning')
export class OutboundWebhooksController {
  constructor(private readonly webhooks: OutboundWebhooksService) {}

  @Get()
  list(@CurrentTenant() tenantId: string) { return this.webhooks.list(tenantId); }

  @Post()
  create(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: { label: string; url: string; eventTypes?: string[] }) {
    return this.webhooks.create(tenantId, user.id, body);
  }

  @Post(':id/rotate')
  rotate(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.webhooks.rotate(tenantId, user.id, id); }

  @Post(':id/revoke')
  revoke(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.webhooks.revoke(tenantId, user.id, id); }

  @Get(':id/deliveries')
  deliveries(@CurrentTenant() tenantId: string, @Param('id') id: string, @Query('limit') limit?: string) { return this.webhooks.listDeliveries(tenantId, id, Number(limit) || 50); }
}
