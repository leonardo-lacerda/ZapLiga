import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { NumberHealthService } from './number-health.service';
import { OperationHealthService } from './operation-health.service';

@Controller('/api/tenants/:tenantId')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('operation_health')
export class OperationHealthController {
  constructor(private readonly health: OperationHealthService, private readonly numbers: NumberHealthService) {}

  @Get('operation-health')
  current(@CurrentTenant() tenantId: string) { return this.health.current(tenantId); }

  @Get('operation-health/history')
  history(@CurrentTenant() tenantId: string, @Query('limit') limit?: string) { return this.health.history(tenantId, Number(limit) || 100); }

  @Get('numbers/:numberId/health')
  number(@CurrentTenant() tenantId: string, @Param('numberId') numberId: string) { return this.numbers.get(tenantId, numberId); }

  @Get('numbers/:numberId/health/events')
  numberEvents(@CurrentTenant() tenantId: string, @Param('numberId') numberId: string, @Query('limit') limit?: string) { return this.numbers.events(tenantId, numberId, Number(limit) || 100); }
}
