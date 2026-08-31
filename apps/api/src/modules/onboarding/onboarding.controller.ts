import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { OnboardingService } from './onboarding.service';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@RequiresFeature('onboarding')
@Roles('leader', 'super_admin')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}
  @Get(['/api/onboarding', '/api/tenants/:tenantId/onboarding']) status(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.onboarding.status(tenantId, user.id); }
  @Post(['/api/onboarding/audio-tested', '/api/tenants/:tenantId/onboarding/audio-tested']) audio(@CurrentTenant() tenantId: string, @CurrentUser() user: any) { return this.onboarding.completeAudio(tenantId, user.id); }
}
