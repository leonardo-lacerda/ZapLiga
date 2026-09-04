import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { EligibilityMode, EligibilityService } from './eligibility.service';

const modes: EligibilityMode[] = ['automatic', 'manual', 'preview', 'simulation'];

@Controller('/api/tenants/:tenantId/leads')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin', 'sdr')
@RequiresFeature('decision_engine')
export class EligibilityController {
  constructor(private readonly eligibility: EligibilityService) {}

  @Get(':leadId/eligibility')
  inspect(@CurrentTenant() tenantId: string, @Param('leadId') leadId: string, @Query('mode') mode?: string) {
    const normalized = (mode || 'preview') as EligibilityMode;
    if (!modes.includes(normalized)) throw new BadRequestException(`Modo de elegibilidade invalido: ${mode}`);
    return this.eligibility.inspectLead(tenantId, leadId, normalized);
  }
}
