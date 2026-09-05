import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { AnalyticsLearningService } from './analytics-learning.service';

@Controller('/api/tenants/:tenantId/analytics/learning')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('analytics_learning')
export class AnalyticsLearningController {
  constructor(private readonly learning: AnalyticsLearningService) {}

  @Get('aggregates') aggregates(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('dimension') dimension?: string) { return this.learning.aggregates(tenantId, from, to, dimension); }
  @Get('monitor') monitor(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) { return this.learning.monitor(tenantId, from, to); }
  @Get('insights') insights(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) { return this.learning.insights(tenantId, from, to); }
  @Post('rebuild') rebuild(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string, @Body() _body?: Record<string, unknown>, @CurrentUser() _user?: any) { return this.learning.rebuild(tenantId, from, to); }
}
