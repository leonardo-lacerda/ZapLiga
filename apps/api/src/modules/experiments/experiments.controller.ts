import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CreateExperimentDto, ExperimentStopDto } from './experiments.dto';
import { ExperimentsService } from './experiments.service';

@Controller('/api/tenants/:tenantId/experiments')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard)
@Roles('leader', 'super_admin')
@RequiresFeature('experiments')
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Get()
  list(@CurrentTenant() tenantId: string) { return this.experiments.list(tenantId); }

  @Post()
  create(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() input: CreateExperimentDto) { return this.experiments.create(tenantId, user.id, input); }

  @Get(':experimentId')
  get(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string) { return this.experiments.get(tenantId, experimentId); }

  @Post(':experimentId/start')
  start(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string, @CurrentUser() user: any) { return this.experiments.start(tenantId, experimentId, user.id); }

  @Post(':experimentId/pause')
  pause(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string, @CurrentUser() user: any) { return this.experiments.pause(tenantId, experimentId, user.id); }

  @Post(':experimentId/stop')
  stop(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string, @CurrentUser() user: any, @Body() input: ExperimentStopDto) { return this.experiments.stop(tenantId, experimentId, user.id, input.reason); }

  @Post(':experimentId/evaluate-guardrails')
  evaluateGuardrails(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string) { return this.experiments.evaluateGuardrails(tenantId, experimentId); }

  @Get(':experimentId/report')
  report(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string) { return this.experiments.report(tenantId, experimentId); }

  @Post(':experimentId/leads/:leadId/assignment')
  assignment(@CurrentTenant() tenantId: string, @Param('experimentId') experimentId: string, @Param('leadId') leadId: string) { return this.experiments.assign(tenantId, experimentId, leadId); }
}
