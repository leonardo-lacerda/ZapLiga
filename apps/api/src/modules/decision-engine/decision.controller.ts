import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { DecisionModeDto, SimulateDecisionDto, UpdateDecisionPolicyDto } from './scoring.dto';
import { DecisionPolicyService } from './decision-policy.service';

@Controller('/api/tenants/:tenantId')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('decision_engine')
export class DecisionController {
  constructor(private readonly decisions: DecisionPolicyService) {}

  @Get('campaigns/:campaignId/decision-policy')
  @Roles('leader', 'super_admin')
  policy(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string) { return this.decisions.getPolicy(tenantId, campaignId); }

  @Put('campaigns/:campaignId/decision-policy')
  @Roles('leader', 'super_admin')
  updatePolicy(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: UpdateDecisionPolicyDto) { return this.decisions.updatePolicy(tenantId, campaignId, user.id, input); }

  @Post('campaigns/:campaignId/decision-policy/simulate')
  @Roles('leader', 'super_admin', 'sdr')
  simulate(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @Body() input: SimulateDecisionDto) { return this.decisions.simulate(tenantId, campaignId, input); }

  @Get('campaigns/:campaignId/decision-comparison')
  @Roles('leader', 'super_admin', 'sdr')
  comparison(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string) { return this.decisions.comparison(tenantId, campaignId); }

  @Post('campaigns/:campaignId/decision-mode')
  @Roles('leader', 'super_admin')
  mode(@CurrentTenant() tenantId: string, @Param('campaignId') campaignId: string, @CurrentUser() user: any, @Body() input: DecisionModeDto) { return this.decisions.setMode(tenantId, campaignId, user.id, input.mode); }

  @Get('leads/:leadId/decision')
  @Roles('leader', 'super_admin', 'sdr')
  leadDecision(@CurrentTenant() tenantId: string, @Param('leadId') leadId: string) { return this.decisions.leadDecision(tenantId, leadId); }
}
