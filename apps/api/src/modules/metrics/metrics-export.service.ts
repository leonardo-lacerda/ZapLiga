import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { AuditService } from '../audit/audit.service';
import { MetricsSummaryQueryDto } from './dto/metrics-summary-query.dto';
import { civilDateInTimezone } from './metrics.formulas';
import { buildCsv, CsvColumn } from './metrics-csv';
import { ExportFileRow, MetricsExportRepository } from './metrics-export.repository';
import { DEFAULT_TENANT_TIMEZONE } from './metrics.definitions';
import { GoalResponse, MetricsGoalsService } from './metrics-goals.service';
import { ReportPeriodPreset, resolveReportPeriod } from './metrics-report-periods';
import { MetricsRepository } from './metrics.repository';
import { MetricsService } from './metrics.service';
import { MetricValue, MetricsSummaryResponse } from './metrics.types';

// Datasets pequenos (no máximo algumas centenas de linhas — uma por SDR,
// pasta ou número) sempre saem síncronos. `calls`/`leads` podem ter dezenas
// de milhares de linhas, então checam o total antes: abaixo do limite saem
// na hora, acima viram um job processado em segundo plano (plano seção 13:
// "criar processamento assíncrono para arquivos grandes").
const SYNC_EXPORT_ROW_LIMIT = 5000;
const MAX_EXPORT_ROWS = 100_000;

const SDR_COLUMNS: CsvColumn[] = [
  { key: 'name', label: 'SDR' }, { key: 'status', label: 'Status' }, { key: 'callsMade', label: 'Chamadas' },
  { key: 'uniqueLeadsWorked', label: 'Leads únicos' }, { key: 'callsAnswered', label: 'Atendidas' }, { key: 'answerRate', label: 'Taxa de atendimento (%)' },
  { key: 'avgDurationSeconds', label: 'Duração média (s)' }, { key: 'connectedSeconds', label: 'Tempo conectado (s)' },
  { key: 'positiveResults', label: 'Resultados positivos' }, { key: 'stageAdvances', label: 'Avanço de etapa' },
  { key: 'wrapUpsCompleted', label: 'Pós-atendimentos' }, { key: 'wrapUpRate', label: 'Taxa de registro (%)' },
];
const FOLDER_COLUMNS: CsvColumn[] = [
  { key: 'name', label: 'Pasta' }, { key: 'totalLeads', label: 'Leads totais' }, { key: 'leadsWorked', label: 'Leads trabalhados' },
  { key: 'currentQueue', label: 'Fila atual' }, { key: 'callsMade', label: 'Chamadas' }, { key: 'answerRate', label: 'Atendimento (%)' },
  { key: 'positiveResults', label: 'Resultado positivo' }, { key: 'stageAdvances', label: 'Avanço de etapa' },
  { key: 'conversions', label: 'Conversões' }, { key: 'bestHour', label: 'Melhor horário' },
];
const NUMBER_COLUMNS: CsvColumn[] = [
  { key: 'label', label: 'Número' }, { key: 'status', label: 'Status' }, { key: 'callsMade', label: 'Chamadas' },
  { key: 'answerRate', label: 'Atendimento (%)' }, { key: 'failed', label: 'Falhas' }, { key: 'activeCalls', label: 'Chamadas simultâneas' },
  { key: 'maxConcurrentCalls', label: 'Limite' }, { key: 'utilization', label: 'Utilização (%)' },
  { key: 'cooldownRemainingSeconds', label: 'Cooldown (s)' }, { key: 'quarantineRemainingSeconds', label: 'Quarentena (s)' }, { key: 'lastActivityAt', label: 'Última atividade' },
];
const CALL_COLUMNS: CsvColumn[] = [
  { key: 'createdAt', label: 'Criada em' }, { key: 'leadName', label: 'Lead' }, { key: 'leadPhone', label: 'Telefone' },
  { key: 'folderName', label: 'Pasta' }, { key: 'sdrName', label: 'SDR' }, { key: 'numberLabel', label: 'Número' },
  { key: 'source', label: 'Origem' }, { key: 'attemptNumber', label: 'Tentativa' }, { key: 'status', label: 'Status' },
  { key: 'callResult', label: 'Resultado' }, { key: 'pipelineStage', label: 'Etapa' },
  { key: 'durationSeconds', label: 'Duração total (s)' }, { key: 'ringDurationSeconds', label: 'Duração do toque (s)' }, { key: 'connectedDurationSeconds', label: 'Duração conectada (s)' },
  { key: 'wrapUpCompletedAt', label: 'Pós-atendimento concluído em' }, { key: 'failureReason', label: 'Motivo da falha' }, { key: 'notes', label: 'Nota' },
];
const LEAD_COLUMNS: CsvColumn[] = [
  { key: 'name', label: 'Lead' }, { key: 'phone', label: 'Telefone' }, { key: 'folderName', label: 'Pasta' },
  { key: 'status', label: 'Status' }, { key: 'pipelineStage', label: 'Etapa' }, { key: 'attempts', label: 'Tentativas' },
  { key: 'doNotCall', label: 'Não ligar' }, { key: 'nextEligibleAt', label: 'Próxima tentativa em' }, { key: 'createdAt', label: 'Criado em' },
];

export type SyncExportResult = { async: false; fileName: string; contentType: string; content: string | Buffer };
export type AsyncExportResult = { async: true; exportId: string };

function formatSecondsPlain(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s` : `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function formatKpi(metric: MetricValue, suffix = ''): string {
  const change = metric.changePercent === null ? 'sem comparação' : `${metric.changePercent >= 0 ? '+' : ''}${metric.changePercent}% vs período anterior`;
  return `${metric.value}${suffix} (${change})`;
}

@Injectable()
export class MetricsExportService {
  constructor(
    private readonly metrics: MetricsService,
    private readonly repo: MetricsRepository,
    private readonly exportRepo: MetricsExportRepository,
    private readonly audit: AuditService,
    private readonly goalsService: MetricsGoalsService,
  ) {}

  async exportCsv(tenantId: string, userId: string, dataset: string, query: MetricsSummaryQueryDto): Promise<SyncExportResult | AsyncExportResult> {
    if (!['sdrs', 'folders', 'numbers', 'calls', 'leads'].includes(dataset)) throw new BadRequestException('dataset inválido — use sdrs, folders, numbers, calls ou leads');

    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_export.requested', entityType: 'metric_export', metadata: { dataset, format: 'csv', filters: query } });

    if (dataset === 'sdrs') {
      const rows = await this.metrics.sdrRanking(tenantId, query);
      return this.syncCsv(`sdrs-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`, SDR_COLUMNS, rows as unknown as Record<string, unknown>[]);
    }
    if (dataset === 'folders') {
      const rows = await this.metrics.folderRanking(tenantId, query);
      return this.syncCsv(`pastas-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`, FOLDER_COLUMNS, rows as unknown as Record<string, unknown>[]);
    }
    if (dataset === 'numbers') {
      const rows = await this.metrics.numberRanking(tenantId, query);
      return this.syncCsv(`numeros-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`, NUMBER_COLUMNS, rows as unknown as Record<string, unknown>[]);
    }
    return this.exportDrilldown(tenantId, userId, dataset as 'calls' | 'leads', query);
  }

  private syncCsv(fileName: string, columns: CsvColumn[], rows: Record<string, unknown>[]): SyncExportResult {
    return { async: false, fileName, contentType: 'text/csv; charset=utf-8', content: buildCsv(columns, rows) };
  }

  private async exportDrilldown(tenantId: string, userId: string, dataset: 'calls' | 'leads', query: MetricsSummaryQueryDto): Promise<SyncExportResult | AsyncExportResult> {
    const probe = dataset === 'calls'
      ? await this.metrics.callsDrilldown(tenantId, { ...query, limit: '1', offset: '0' })
      : await this.metrics.leadsDrilldown(tenantId, { ...(query as any), limit: '1', offset: '0' });
    if (probe.total === 0) {
      const columns = dataset === 'calls' ? CALL_COLUMNS : LEAD_COLUMNS;
      return this.syncCsv(`${dataset}-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`, columns, []);
    }
    if (probe.total > MAX_EXPORT_ROWS) throw new BadRequestException(`O conjunto filtrado tem ${probe.total} linhas, acima do limite de ${MAX_EXPORT_ROWS} por exportação — refine os filtros ou o período.`);

    if (probe.total <= SYNC_EXPORT_ROW_LIMIT) {
      const page = dataset === 'calls'
        ? await this.metrics.callsDrilldown(tenantId, { ...query, limit: String(probe.total), offset: '0' })
        : await this.metrics.leadsDrilldown(tenantId, { ...(query as any), limit: String(probe.total), offset: '0' });
      const columns = dataset === 'calls' ? CALL_COLUMNS : LEAD_COLUMNS;
      return this.syncCsv(`${dataset}-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`, columns, page.items as unknown as Record<string, unknown>[]);
    }

    const exportId = randomUUID();
    await this.exportRepo.createJob({ id: exportId, tenantId, requestedBy: userId, dataset, format: 'csv', filters: query });
    this.processInBackground(tenantId, exportId, dataset, query, probe.total);
    return { async: true, exportId };
  }

  private processInBackground(tenantId: string, exportId: string, dataset: 'calls' | 'leads', query: MetricsSummaryQueryDto, total: number) {
    setImmediate(async () => {
      try {
        const rowLimit = Math.min(total, MAX_EXPORT_ROWS);
        const page = dataset === 'calls'
          ? await this.metrics.callsDrilldown(tenantId, { ...query, limit: String(rowLimit), offset: '0' })
          : await this.metrics.leadsDrilldown(tenantId, { ...(query as any), limit: String(rowLimit), offset: '0' });
        const columns = dataset === 'calls' ? CALL_COLUMNS : LEAD_COLUMNS;
        const csv = buildCsv(columns, page.items as unknown as Record<string, unknown>[]);
        await this.exportRepo.complete(exportId, {
          rowCount: page.items.length,
          fileName: `${dataset}-${civilDateInTimezone(new Date(), DEFAULT_TENANT_TIMEZONE)}.csv`,
          contentType: 'text/csv; charset=utf-8',
          fileData: Buffer.from(csv, 'utf8'),
        });
      } catch (error) {
        await this.exportRepo.fail(exportId, error instanceof Error ? error.message : String(error));
      }
    });
  }

  async getJobStatus(tenantId: string, id: string) {
    const job = await this.exportRepo.findById(tenantId, id);
    if (!job) throw new NotFoundException('Exportação não encontrada');
    return {
      id: job.id, status: job.status, dataset: job.dataset, format: job.format,
      rowCount: job.row_count, fileName: job.file_name, errorMessage: job.error_message,
      createdAt: job.created_at, completedAt: job.completed_at,
    };
  }

  async downloadJob(tenantId: string, id: string): Promise<ExportFileRow> {
    const file = await this.exportRepo.findFileById(tenantId, id);
    if (!file) throw new NotFoundException('Exportação não encontrada');
    if (file.status === 'processing') throw new BadRequestException('A exportação ainda está sendo processada');
    if (file.status === 'failed') throw new BadRequestException('Esta exportação falhou — solicite uma nova');
    return file;
  }

  async exportPdf(tenantId: string, userId: string, query: MetricsSummaryQueryDto, preset: ReportPeriodPreset): Promise<{ fileName: string; content: Buffer }> {
    let resolvedQuery = query;
    if (preset !== 'custom') {
      const timezone = (await this.repo.tenantTimezone(tenantId)) || DEFAULT_TENANT_TIMEZONE;
      const today = civilDateInTimezone(new Date(), timezone);
      const range = resolveReportPeriod(preset, today);
      if (range) resolvedQuery = { ...query, from: range.from, to: range.to };
    }

    const summary = await this.metrics.summary(tenantId, resolvedQuery);
    const goals = await this.goalsService.list(tenantId, { status: 'active' });
    const content = await this.renderPdf(summary, goals);
    const fileName = `metricas-${summary.period.from.slice(0, 10)}-a-${summary.period.to.slice(0, 10)}.pdf`;

    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_export.requested', entityType: 'metric_export', metadata: { dataset: 'summary', format: 'pdf', preset, filters: resolvedQuery } });
    return { fileName, content };
  }

  private renderPdf(summary: MetricsSummaryResponse, goals: GoalResponse[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 42, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(18).fillColor('#1d2939').text('Relatório de Métricas — ZapLiga');
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#667085');
      doc.text(`Período: ${summary.period.from.slice(0, 10)} a ${summary.period.to.slice(0, 10)} (fuso ${summary.period.timezone})`);
      doc.text(`Gerado em: ${new Date(summary.freshness.generatedAt).toLocaleString('pt-BR')}`);
      const filterParts: string[] = [];
      if (summary.filters.folderIds.length) filterParts.push(`${summary.filters.folderIds.length} pasta(s)`);
      if (summary.filters.sdrIds.length) filterParts.push(`${summary.filters.sdrIds.length} SDR(s)`);
      if (summary.filters.numberIds.length) filterParts.push(`${summary.filters.numberIds.length} número(s)`);
      if (summary.filters.source !== 'all') filterParts.push(`origem: ${summary.filters.source}`);
      if (summary.filters.callResults.length) filterParts.push(`${summary.filters.callResults.length} resultado(s)`);
      if (summary.filters.pipelineStages.length) filterParts.push(`${summary.filters.pipelineStages.length} etapa(s)`);
      doc.text(`Filtros ativos: ${filterParts.length ? filterParts.join(', ') : 'nenhum'}`);
      doc.moveDown(0.8);

      doc.fillColor('#1d2939').fontSize(13).text('Indicadores principais');
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#344054');
      const kpiLines: [string, string][] = [
        ['Chamadas realizadas', formatKpi(summary.kpis.callsMade)],
        ['Leads únicos trabalhados', formatKpi(summary.kpis.uniqueLeadsWorked)],
        ['Chamadas atendidas', formatKpi(summary.kpis.callsAnswered)],
        ['Taxa de atendimento', formatKpi(summary.kpis.answerRate, '%')],
        ['Tempo conectado', formatSecondsPlain(summary.kpis.connectedSeconds.value)],
        ['Duração média', formatSecondsPlain(summary.kpis.avgDurationSeconds.value)],
        ['Resultados positivos', formatKpi(summary.kpis.positiveResults)],
        ['Taxa de pós-atendimento', formatKpi(summary.kpis.wrapUpRate, '%')],
        ['SDRs ativos', formatKpi(summary.kpis.activeSdrs)],
        ['Leads na fila', `${summary.kpis.leadsInQueue.value} (retrato do momento)`],
      ];
      for (const [label, value] of kpiLines) doc.text(`${label}: ${value}`);
      doc.moveDown(0.6);

      doc.fillColor('#1d2939').fontSize(13).text('Funil');
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#344054');
      for (const stage of summary.funnel) doc.text(`${stage.label}: ${stage.count}`);
      doc.moveDown(0.6);

      doc.fillColor('#1d2939').fontSize(13).text('Resultados comerciais');
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#344054');
      if (!summary.outcomes.length) doc.text('Sem chamadas com resultado no período.');
      for (const item of summary.outcomes) doc.text(`${item.label}: ${item.count} (${item.percent}%)`);
      doc.moveDown(0.6);

      doc.fillColor('#1d2939').fontSize(13).text('Etapas do funil');
      doc.moveDown(0.2);
      doc.fontSize(9).fillColor('#344054');
      if (!summary.pipeline.length) doc.text('Sem chamadas no período.');
      for (const item of summary.pipeline) doc.text(`${item.label}: ${item.count} (${item.percent}%)`);
      doc.moveDown(0.6);

      if (goals.length) {
        doc.fillColor('#1d2939').fontSize(13).text('Metas ativas');
        doc.moveDown(0.2);
        doc.fontSize(9).fillColor('#344054');
        for (const goal of goals) {
          const scopeLabel = goal.scope === 'organization' ? 'Organização' : goal.scopeName ?? goal.scope;
          doc.text(`${scopeLabel} — ${goal.metricLabel}: ${goal.progress.actual} de ${goal.targetValue} (${goal.progress.progressPercent}%, ${goal.progress.trend})`);
        }
        doc.moveDown(0.6);
      }

      if (summary.alerts.length) {
        doc.fillColor('#1d2939').fontSize(13).text('Alertas');
        doc.moveDown(0.2);
        for (const alert of summary.alerts) {
          doc.fontSize(9).fillColor('#1d2939').font('Helvetica-Bold').text(`[${alert.severity.toUpperCase()}] ${alert.title}`);
          doc.font('Helvetica').fillColor('#344054').text(alert.evidence);
          doc.text(`Ação sugerida: ${alert.recommendedAction}`);
          doc.moveDown(0.3);
        }
      }

      doc.end();
    });
  }
}
