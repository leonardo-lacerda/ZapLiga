import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
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
  @IsOptional() @IsBoolean() lead_ingestion_api?: boolean;
  @IsOptional() @IsBoolean() advanced_reports?: boolean;
}

@Controller('/api/tenants/:tenantId/feature-flags')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}
  @Get() get(@CurrentTenant() tenantId: string) { return this.flags.get(tenantId); }
  @Get('/effective') effective(@CurrentTenant() tenantId: string) { return this.flags.getEffective(tenantId); }
  @Patch() @Roles('super_admin') @TenantAction('billing_recovery') update(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: UpdateFeatureFlagsDto) { return this.flags.update(tenantId, input, user.id); }
}
