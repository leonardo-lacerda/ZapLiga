import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantAction, TenantMembershipGuard } from '../auth/auth.guards';
import { FeatureFlagGuard, RequiresFeature } from '../feature-flags/feature-flags.guard';
import { CreateGoalDto } from './dto/create-goal.dto';
import { ExportCsvQueryDto, ExportPdfQueryDto } from './dto/export-query.dto';
import { MetricsDrilldownQueryDto } from './dto/metrics-drilldown-query.dto';
import { MetricsSummaryQueryDto } from './dto/metrics-summary-query.dto';
import { ReprocessRollupDto } from './dto/reprocess-rollup.dto';
import { SetRetentionPolicyDto } from './dto/retention-policy.dto';
import { SaveViewDto, UpdateViewDto } from './dto/saved-view.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';
import { MetricsConsistencyService } from './metrics-consistency.service';
import { MetricsExportService } from './metrics-export.service';
import { MetricsGoalsService } from './metrics-goals.service';
import { MetricsPerformanceInterceptor } from './metrics-performance.interceptor';
import { MetricsQueryGuardService } from './metrics-query-guard.service';
import { MetricsRetentionService } from './metrics-retention.service';
import { MetricsRollupService } from './metrics-rollup.service';
import { MetricsViewsService } from './metrics-views.service';
import { MetricsService } from './metrics.service';

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@UseInterceptors(MetricsPerformanceInterceptor)
@Roles('leader', 'super_admin')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly consistency: MetricsConsistencyService,
    private readonly guard: MetricsQueryGuardService,
    private readonly goals: MetricsGoalsService,
    private readonly exportService: MetricsExportService,
    private readonly views: MetricsViewsService,
    private readonly rollup: MetricsRollupService,
    private readonly retention: MetricsRetentionService,
  ) {}

  private async cached<T>(endpoint: string, tenantId: string, userId: string, query: object, compute: () => Promise<T>): Promise<T> {
    await this.guard.enforceRateLimit(tenantId, userId);
    return this.guard.withCache(`${endpoint}:${tenantId}:${JSON.stringify(query)}`, compute);
  }

  @Get(['/api/metrics/summary', '/api/tenants/:tenantId/metrics/summary'])
  summary(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('summary', tenantId, user.id, query, () => this.metrics.summary(tenantId, query));
  }

  @Get(['/api/metrics/trends', '/api/tenants/:tenantId/metrics/trends'])
  trends(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('trends', tenantId, user.id, query, () => this.metrics.trends(tenantId, query));
  }

  @Get(['/api/metrics/funnel', '/api/tenants/:tenantId/metrics/funnel'])
  funnel(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('funnel', tenantId, user.id, query, () => this.metrics.funnel(tenantId, query));
  }

  @Get(['/api/metrics/heatmap', '/api/tenants/:tenantId/metrics/heatmap'])
  heatmap(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('heatmap', tenantId, user.id, query, () => this.metrics.heatmap(tenantId, query));
  }

  @Get(['/api/metrics/sdrs', '/api/tenants/:tenantId/metrics/sdrs'])
  sdrs(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('sdrs', tenantId, user.id, query, () => this.metrics.sdrRanking(tenantId, query));
  }

  @Get(['/api/metrics/folders', '/api/tenants/:tenantId/metrics/folders'])
  folders(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('folders', tenantId, user.id, query, () => this.metrics.folderRanking(tenantId, query));
  }

  @Get(['/api/metrics/numbers', '/api/tenants/:tenantId/metrics/numbers'])
  numbers(@Query() query: MetricsSummaryQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.cached('numbers', tenantId, user.id, query, () => this.metrics.numberRanking(tenantId, query));
  }

  // Drilldown: dados individuais, sempre atuais — sem cache (plano seção 6.5).
  @Get(['/api/metrics/calls', '/api/tenants/:tenantId/metrics/calls'])
  async calls(@Query() query: MetricsDrilldownQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.guard.enforceRateLimit(tenantId, user.id);
    return this.metrics.callsDrilldown(tenantId, query);
  }

  @Get(['/api/metrics/leads', '/api/tenants/:tenantId/metrics/leads'])
  async leads(@Query() query: MetricsDrilldownQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    await this.guard.enforceRateLimit(tenantId, user.id);
    return this.metrics.leadsDrilldown(tenantId, query);
  }

  @Get(['/api/metrics/consistency', '/api/tenants/:tenantId/metrics/consistency'])
  async consistencyCheck(@CurrentTenant() tenantId: string) {
    const issues = await this.consistency.check(tenantId);
    return { checkedAt: new Date().toISOString(), issues };
  }

  // Metas (plano seção 6.7) — sem cache: refletem alterações imediatamente,
  // e a lista já é naturalmente pequena por tenant.
  @Get(['/api/metrics/goals', '/api/tenants/:tenantId/metrics/goals'])
  listGoals(
    @Query('status') status: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query('scopeId') scopeId: string | undefined,
    @CurrentTenant() tenantId: string,
  ) {
    return this.goals.list(tenantId, { status, scope, scopeId });
  }

  @Post(['/api/metrics/goals', '/api/tenants/:tenantId/metrics/goals'])
  createGoal(@Body() body: CreateGoalDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.goals.create(tenantId, user.id, body);
  }

  @Patch(['/api/metrics/goals/:id', '/api/tenants/:tenantId/metrics/goals/:id'])
  updateGoal(@Param('id') id: string, @Body() body: UpdateGoalDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.goals.update(tenantId, user.id, id, body);
  }

  @Delete(['/api/metrics/goals/:id', '/api/tenants/:tenantId/metrics/goals/:id'])
  removeGoal(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.goals.remove(tenantId, user.id, id);
  }

  // Exportação (plano seção 6.8) — sem cache: sempre reflete o estado atual
  // no momento do pedido, e cada exportação já fica registrada na auditoria.
  @Get(['/api/metrics/export.csv', '/api/tenants/:tenantId/metrics/export.csv'])
  @UseGuards(FeatureFlagGuard)
  @RequiresFeature('advanced_reports')
  async exportCsv(@Query() query: ExportCsvQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any, @Res() response: Response) {
    await this.guard.enforceRateLimit(tenantId, user.id);
    const result = await this.exportService.exportCsv(tenantId, user.id, query.dataset, query);
    if (result.async) { response.status(202).json({ exportId: result.exportId, status: 'processing' }); return; }
    response.set({ 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.fileName}"` });
    response.status(200).send(result.content);
  }

  @Get(['/api/metrics/export.pdf', '/api/tenants/:tenantId/metrics/export.pdf'])
  @UseGuards(FeatureFlagGuard)
  @RequiresFeature('advanced_reports')
  async exportPdf(@Query() query: ExportPdfQueryDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any, @Res() response: Response) {
    await this.guard.enforceRateLimit(tenantId, user.id);
    const { fileName, content } = await this.exportService.exportPdf(tenantId, user.id, query, query.period ?? 'custom');
    response.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName}"` });
    response.status(200).send(content);
  }

  @Get(['/api/metrics/exports/:id', '/api/tenants/:tenantId/metrics/exports/:id'])
  exportStatus(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.exportService.getJobStatus(tenantId, id);
  }

  @Get(['/api/metrics/exports/:id/download', '/api/tenants/:tenantId/metrics/exports/:id/download'])
  async downloadExport(@Param('id') id: string, @CurrentTenant() tenantId: string, @Res() response: Response) {
    const file = await this.exportService.downloadJob(tenantId, id);
    response.set({ 'Content-Type': file.content_type, 'Content-Disposition': `attachment; filename="${file.file_name}"` });
    response.status(200).send(file.file_data);
  }

  // Visualizações salvas (plano seção 6.8).
  @Get(['/api/metrics/views', '/api/tenants/:tenantId/metrics/views'])
  listViews(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.views.list(tenantId, user.id);
  }

  @Post(['/api/metrics/views', '/api/tenants/:tenantId/metrics/views'])
  createView(@Body() body: SaveViewDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.views.create(tenantId, user.id, body);
  }

  @Patch(['/api/metrics/views/:id', '/api/tenants/:tenantId/metrics/views/:id'])
  updateView(@Param('id') id: string, @Body() body: UpdateViewDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.views.update(tenantId, user.id, id, body);
  }

  @Delete(['/api/metrics/views/:id', '/api/tenants/:tenantId/metrics/views/:id'])
  removeView(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.views.remove(tenantId, user.id, id);
  }

  // Escala e otimização (plano seção 13, Fase 8).
  @Post(['/api/metrics/rollups/reprocess', '/api/tenants/:tenantId/metrics/rollups/reprocess'])
  reprocessRollup(@Body() body: ReprocessRollupDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.rollup.reprocess(tenantId, user.id, body.from, body.to);
  }

  @Get(['/api/metrics/retention', '/api/tenants/:tenantId/metrics/retention'])
  getRetentionPolicy(@CurrentTenant() tenantId: string) {
    return this.retention.getPolicy(tenantId);
  }

  @Patch(['/api/metrics/retention', '/api/tenants/:tenantId/metrics/retention'])
  @TenantAction('write')
  setRetentionPolicy(@Body() body: SetRetentionPolicyDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.retention.setPolicy(tenantId, user.id, body.retentionDays ?? null);
  }

  // `confirm=true` é obrigatório para realmente apagar — sem ele, só relata
  // o que seria removido (plano seção 11: apagar dados de produção nunca
  // deve ser o comportamento padrão de uma chamada).
  @Post(['/api/metrics/retention/purge', '/api/tenants/:tenantId/metrics/retention/purge'])
  @TenantAction('write')
  purgeExpired(@Query('confirm') confirm: string | undefined, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    return this.retention.purge(tenantId, user.id, confirm === 'true');
  }
}
