import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { RecommendationEventDto } from './dto/recommendation-event.dto';
import { RecommendationsService } from './recommendations.service';

@Controller('/api/tenants/:tenantId/recommendations')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('recommendations')
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  list(@CurrentTenant() tenantId: string, @Query('status') status?: any, @Query('limit') limit?: string) { return this.recommendations.list(tenantId, status, Number(limit) || 3); }

  @Get('history')
  history(@CurrentTenant() tenantId: string, @Query('recommendationId') recommendationId?: string, @Query('limit') limit?: string) { return this.recommendations.history(tenantId, recommendationId, Number(limit) || 100); }

  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id') id: string) { return this.recommendations.get(tenantId, id); }

  @Post(':id/events')
  event(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string, @Body() body: RecommendationEventDto) { return this.recommendations.event(tenantId, id, user.id, body.eventType, body.metadata); }

  @Post(':id/dismiss')
  dismiss(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.recommendations.dismiss(tenantId, id, user.id); }

  @Post(':id/snooze')
  snooze(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.recommendations.snooze(tenantId, id, user.id); }

  @Post(':id/apply')
  apply(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Param('id') id: string) { return this.recommendations.apply(tenantId, id, user.id); }
}
