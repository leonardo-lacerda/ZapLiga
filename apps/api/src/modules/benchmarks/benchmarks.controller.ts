import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { BenchmarkConsentDto, BenchmarkConsentRevokeDto } from './benchmarks.dto';
import { BenchmarksService } from './benchmarks.service';

@Controller('/api/tenants/:tenantId/benchmarks')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('benchmarks')
export class BenchmarksController {
  constructor(private readonly benchmarks: BenchmarksService) {}

  @Get('consent') consent(@CurrentTenant() tenantId: string) { return this.benchmarks.consent(tenantId); }

  @Post('consent/opt-in') optIn(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: BenchmarkConsentDto) { return this.benchmarks.optIn(tenantId, user.id, input); }

  @Post('consent/revoke') revoke(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: BenchmarkConsentRevokeDto) { return this.benchmarks.revoke(tenantId, user.id, input.reason); }

  @Get('cohorts') cohorts(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) { return this.benchmarks.cohorts(tenantId, from, to); }
}

@Controller('/api/admin/benchmarks')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class BenchmarkAdminController {
  constructor(private readonly benchmarks: BenchmarksService) {}

  @Get('cohorts') inspect(@Query('from') from?: string, @Query('to') to?: string) { return this.benchmarks.inspectCohorts(from, to); }

  @Post('refresh') refresh(@Query('from') from?: string, @Query('to') to?: string) { return this.benchmarks.refreshCohorts(from, to); }
}
