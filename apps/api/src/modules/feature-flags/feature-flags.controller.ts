import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagsService } from './feature-flags.service';

class UpdateFeatureFlagsDto {
  @IsOptional() @IsBoolean() schedule_enforcement?: boolean;
  @IsOptional() @IsBoolean() callbacks?: boolean;
  @IsOptional() @IsBoolean() privacy_requests?: boolean;
  @IsOptional() @IsBoolean() onboarding?: boolean;
  @IsOptional() @IsBoolean() campaigns?: boolean;
  @IsOptional() @IsBoolean() decision_engine?: boolean;
  @IsOptional() @IsBoolean() recommendations?: boolean;
  @IsOptional() @IsBoolean() operation_health?: boolean;
  @IsOptional() @IsBoolean() analytics_learning?: boolean;
  @IsOptional() @IsBoolean() experiments?: boolean;
  @IsOptional() @IsBoolean() benchmarks?: boolean;
}

@Controller('/api/tenants/:tenantId/feature-flags')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}
  @Get() get(@CurrentTenant() tenantId: string) { return this.flags.get(tenantId); }
  @Patch() @Roles('super_admin') update(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: UpdateFeatureFlagsDto) { return this.flags.update(tenantId, input, user.id); }
}
