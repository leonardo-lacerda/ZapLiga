import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { LineLearningsService } from './line-learnings.service';
import { EXPORT_DATASETS, ExportDataset, LineMonitorService } from './line-monitor.service';

const optionalText = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} inválido`);
  return value;
};

/** The "Monitor de linhas" tab (docs/line-monitor.md). Dates are YYYY-MM-DD in the tenant's timezone. */
@Controller('/api/tenants/:tenantId/line-monitor')
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class LineMonitorController {
  constructor(private readonly monitor: LineMonitorService, private readonly learnings: LineLearningsService) {}

  @Get('/now')
  now(@CurrentTenant() tenantId: string) { return this.monitor.now(tenantId); }

  @Get('/period')
  async period(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.monitor.periodReport(tenantId, await this.monitor.period(tenantId, optionalText(from, 'from'), optionalText(to, 'to')));
  }

  @Get('/timeline')
  async timeline(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('numberId') numberId?: string) {
    return this.monitor.timeline(tenantId, await this.monitor.period(tenantId, optionalText(from, 'from'), optionalText(to, 'to')), optionalText(numberId, 'numberId'));
  }

  @Get('/history')
  async history(@CurrentTenant() tenantId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.monitor.history(tenantId, await this.monitor.period(tenantId, optionalText(from, 'from'), optionalText(to, 'to')));
  }

  @Get('/export.csv')
  async exportCsv(@CurrentTenant() tenantId: string, @Res() response: Response, @Query('dataset') dataset?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (!EXPORT_DATASETS.includes(dataset as ExportDataset)) throw new BadRequestException(`dataset deve ser ${EXPORT_DATASETS.join(', ')}`);
    const period = await this.monitor.period(tenantId, optionalText(from, 'from'), optionalText(to, 'to'));
    const { fileName, content } = await this.monitor.exportCsv(tenantId, dataset as ExportDataset, period);
    response.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"` });
    response.status(200).send(content);
  }

  @Post('/notes')
  addNote(@CurrentTenant() tenantId: string, @CurrentUser() user: any, @Body() body: { body?: unknown; numberId?: unknown; occurredAt?: unknown }) {
    if (typeof body?.body !== 'string') throw new BadRequestException('Escreva a nota');
    return this.monitor.addNote(tenantId, user.id, { body: body.body, numberId: optionalText(body.numberId, 'numberId'), occurredAt: optionalText(body.occurredAt, 'occurredAt') });
  }

  @Delete('/notes/:id')
  removeNote(@CurrentTenant() tenantId: string, @Param('id') id: string) { return this.monitor.removeNote(tenantId, id); }

  @Get('/learnings')
  latest(@CurrentTenant() tenantId: string) { return this.learnings.latest(tenantId); }

  @Get('/learnings/runs')
  runs(@CurrentTenant() tenantId: string) { return this.learnings.runs(tenantId); }

  @Get('/learnings/runs/:id')
  run(@CurrentTenant() tenantId: string, @Param('id') id: string) { return this.learnings.run(tenantId, id); }

  @Post('/learnings/rebuild')
  rebuild(@CurrentTenant() tenantId: string, @Body() body: { from?: unknown; to?: unknown }) {
    return this.learnings.compute(tenantId, { trigger: 'manual', from: optionalText(body?.from, 'from'), to: optionalText(body?.to, 'to') });
  }
}
