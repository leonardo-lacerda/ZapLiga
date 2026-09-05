import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { AnalyticsEventsService } from './analytics-events.service';

@Controller('/api/tenants/:tenantId/analytics')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('analytics_learning')
export class AnalyticsEventsController {
  constructor(private readonly analytics: AnalyticsEventsService) {}

  @Get('event-catalog')
  catalog() { return this.analytics.catalog(); }

  @Get('events')
  events(@CurrentTenant() tenantId: string, @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.analytics.listEvents(tenantId, Number(limit) || 50, Number(offset) || 0); }

  @Get('reliability')
  reliability(@CurrentTenant() tenantId: string) { return this.analytics.reliability(tenantId); }

  @Post('reconcile')
  reconcile(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) { return this.analytics.reconcile(tenantId, from, to); }

  @Get('outbox')
  outbox(@CurrentTenant() tenantId: string) { return this.analytics.outboxHealth(tenantId); }
}
