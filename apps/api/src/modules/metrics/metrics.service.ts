import { BadRequestException, Injectable } from '@nestjs/common';
import { MetricsSummaryQueryDto } from './dto/metrics-summary-query.dto';
import { buildAlerts } from './metrics-alerts';
import { MetricsGoalsService } from './metrics-goals.service';
import { CALL_RESULT_CATALOG, CallResultCode, DEFAULT_TENANT_TIMEZONE, NO_RESULT_CODE, NO_STAGE_CODE, PIPELINE_STAGE_CATALOG, PipelineStageCode } from './metrics.definitions';
import { answerRate, avgConnectedDurationSeconds, civilDateInTimezone, compareToPrevious, dayRangeInTimezone, daysBetweenDateStrs, numberUtilization, safeRate, shiftDateStr, wrapUpRate } from './metrics.formulas';
import { CallFilters, MetricsRepository, TrendGranularity } from './metrics.repository';
import { MetricsBreakdownItem, MetricsFolderRanking, MetricsFunnelStage, MetricsHeatmapCell, MetricsKpis, MetricsNumberRanking, MetricsPage, MetricsSdrRanking, MetricsSummaryResponse, MetricsTrendPoint, MetricValue } from './metrics.types';

const OPEN_WRAP_UP_MINUTES_THRESHOLD = 10;

const MAX_SYNC_RANGE_DAYS = 366;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function toMetricValue(value: number, previousValue: number, numerator?: number, denominator?: number): MetricValue {
  return { value, previousValue, numerator, denominator, ...compareToPrevious(value, previousValue) };
}

/** Granularidade automática por tamanho do período (plano seção 6.3). */
function autoGranularity(rangeDays: number): TrendGranularity {
  if (rangeDays <= 2) return 'hour';
  if (rangeDays <= 120) return 'day';
  return 'week';
}

type ResolvedPeriod = {
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  compareStart: Date;
  compareEnd: Date;
  rangeDays: number;
  filters: CallFilters;
};

@Injectable()
export class MetricsService {
  constructor(private readonly repo: MetricsRepository, private readonly goals: MetricsGoalsService) {}

  private async resolvePeriod(tenantId: string, query: MetricsSummaryQueryDto): Promise<ResolvedPeriod> {
    const now = new Date();
    const timezone = query.timezone?.trim() || (await this.repo.tenantTimezone(tenantId)) || DEFAULT_TENANT_TIMEZONE;

    const toStr = query.to ?? civilDateInTimezone(now, timezone);
    const fromStr = query.from ?? shiftDateStr(toStr, -6);
    if (fromStr > toStr) throw new BadRequestException('O período "from" não pode ser posterior a "to"');
    const rangeDays = daysBetweenDateStrs(fromStr, toStr) + 1;
    if (rangeDays > MAX_SYNC_RANGE_DAYS) throw new BadRequestException(`O período máximo por consulta síncrona é de ${MAX_SYNC_RANGE_DAYS} dias`);

    const compareToStr = query.compareTo ?? shiftDateStr(fromStr, -1);
    const compareFromStr = query.compareFrom ?? shiftDateStr(compareToStr, -(rangeDays - 1));

    const { startUtc: periodStart } = dayRangeInTimezone(fromStr, timezone);
    const { endUtc: periodEnd } = dayRangeInTimezone(toStr, timezone);
    const { startUtc: compareStart } = dayRangeInTimezone(compareFromStr, timezone);
    const { endUtc: compareEnd } = dayRangeInTimezone(compareToStr, timezone);

    const filters: CallFilters = {
      folderIds: query.folderIds,
      sdrIds: query.sdrIds,
      numberIds: query.numberIds,
      source: query.source,
      callResults: query.callResults,
      pipelineStages: query.pipelineStages,
      statuses: query.statuses,
    };

    return { timezone, periodStart, periodEnd, compareStart, compareEnd, rangeDays, filters };
  }

  private echoFilters(query: MetricsSummaryQueryDto) {
    return {
      folderIds: query.folderIds ?? [],
      sdrIds: query.sdrIds ?? [],
      numberIds: query.numberIds ?? [],
      source: query.source ?? ('all' as const),
      callResults: query.callResults ?? [],
      pipelineStages: query.pipelineStages ?? [],
      statuses: query.statuses ?? [],
    };
  }

  private paginationParams(query: { limit?: string; offset?: string }) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(query.offset) || 0);
    return { limit, offset };
  }

  private buildFunnelStages(uniqueLeadsWorked: number, counts: Awaited<ReturnType<MetricsRepository['funnelCounts']>>): MetricsFunnelStage[] {
    return [
      { stage: 'available', label: 'Leads disponíveis', count: counts.leadsAvailable, rule: 'Leads não marcados como "não ligar" criados até o fim do período, na(s) pasta(s) filtrada(s)' },
      { stage: 'worked', label: 'Leads trabalhados', count: uniqueLeadsWorked, rule: 'Leads com pelo menos uma chamada no período (COUNT DISTINCT lead_id em calls)' },
      { stage: 'answered', label: 'Leads atendidos', count: counts.leadsAnswered, rule: 'Leads com pelo menos uma chamada com connected_at preenchido no período' },
      { stage: 'wrapped_up', label: 'Leads com pós-atendimento', count: counts.leadsWrappedUp, rule: 'Leads com pelo menos uma chamada com wrap_up_completed_at preenchido no período' },
      { stage: 'positive', label: 'Leads com resultado positivo', count: counts.leadsPositive, rule: 'Leads com call_result classificado como positivo ou conversão no catálogo do tenant' },
      { stage: 'advanced', label: 'Leads avançados', count: counts.leadsAdvanced, rule: 'Leads com uma transição de etapa registrada em lead_stage_history (origem "wrap_up") no período' },
      { stage: 'converted', label: 'Conversões', count: counts.leadsConverted, rule: 'Leads com call_result ou pipeline_stage classificados como conversão no catálogo do tenant' },
    ];
  }

  private buildTrendPoints(rows: Awaited<ReturnType<MetricsRepository['trends']>>): MetricsTrendPoint[] {
    return rows.map((row) => ({
      bucket: new Date(row.bucket).toISOString(),
      callsMade: row.calls_made,
      callsAnswered: row.calls_answered,
      answerRate: answerRate(row.calls_answered, row.calls_made),
      uniqueLeadsWorked: row.unique_leads_worked,
      positiveResults: row.positive_results,
      connectedSeconds: row.connected_seconds,
    }));
  }

  private mapFolderRanking(rows: Awaited<ReturnType<MetricsRepository['folderRanking']>>): MetricsFolderRanking[] {
    return rows.map((row) => ({
      folderId: row.id,
      name: row.name,
      isActive: Boolean(row.is_active),
      totalLeads: Number(row.total_leads),
      leadsWorked: Number(row.unique_leads_worked),
      currentQueue: Number(row.current_queue),
      callsMade: Number(row.calls_made),
      callsAnswered: Number(row.calls_answered),
      answerRate: answerRate(Number(row.calls_answered), Number(row.calls_made)),
      positiveResults: Number(row.positive_results),
      stageAdvances: Number(row.stage_advances),
      conversions: Number(row.conversions),
      bestHour: row.best_hour === null || row.best_hour === undefined ? null : Number(row.best_hour),
    }));
  }

  private mapNumberRanking(rows: Awaited<ReturnType<MetricsRepository['numberRanking']>>): MetricsNumberRanking[] {
    const now = Date.now();
    return rows.map((row) => {
      const flaggedUntil = row.flagged_until ? new Date(row.flagged_until).getTime() : null;
      const lastCallEndedAt = row.last_call_ended_at ? new Date(row.last_call_ended_at).getTime() : null;
      const cooldownSeconds = Number(row.cooldown_seconds ?? 0);
      const cooldownRemaining = lastCallEndedAt ? Math.max(0, Math.ceil((lastCallEndedAt + cooldownSeconds * 1000 - now) / 1000)) : 0;
      const quarantineRemaining = flaggedUntil ? Math.max(0, Math.ceil((flaggedUntil - now) / 1000)) : 0;
      return {
        numberId: row.id,
        label: row.label,
        status: row.status,
        callsMade: Number(row.calls_made),
        callsAnswered: Number(row.calls_answered),
        answerRate: answerRate(Number(row.calls_answered), Number(row.calls_made)),
        failed: Number(row.failed),
        activeCalls: Number(row.active_calls),
        maxConcurrentCalls: Number(row.max_concurrent_calls),
        utilization: numberUtilization(Number(row.active_calls), Number(row.max_concurrent_calls)),
        cooldownRemainingSeconds: cooldownRemaining,
        quarantineRemainingSeconds: quarantineRemaining,
        lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
      };
    });
  }

  async summary(tenantId: string, query: MetricsSummaryQueryDto): Promise<MetricsSummaryResponse> {
    const now = new Date();
    const { timezone, periodStart, periodEnd, compareStart, compareEnd, rangeDays, filters } = await this.resolvePeriod(tenantId, query);
    const granularity = autoGranularity(rangeDays);

    const [current, previous, outcomeRows, pipelineRows, leadsInQueue, realtime, trendRows, funnelCounts, folderRows, numberRows, openWrapUpRows, activeGoals] = await Promise.all([
      this.repo.callAggregates(tenantId, periodStart, periodEnd, filters),
      this.repo.callAggregates(tenantId, compareStart, compareEnd, filters),
      this.repo.outcomeBreakdown(tenantId, periodStart, periodEnd, filters),
      this.repo.pipelineBreakdown(tenantId, periodStart, periodEnd, filters),
      this.repo.leadsInQueueCount(tenantId, query.folderIds),
      this.repo.realtimeSnapshot(tenantId),
      this.repo.trends(tenantId, periodStart, periodEnd, filters, timezone, granularity),
      this.repo.funnelCounts(tenantId, periodStart, periodEnd, filters),
      this.repo.folderRanking(tenantId, periodStart, periodEnd, filters),
      this.repo.numberRanking(tenantId, periodStart, periodEnd, filters),
      this.repo.openWrapUps(tenantId, OPEN_WRAP_UP_MINUTES_THRESHOLD),
      this.goals.list(tenantId, { status: 'active' }),
    ]);

    const kpis: MetricsKpis = {
      callsMade: toMetricValue(current.callsMade, previous.callsMade),
      uniqueLeadsWorked: toMetricValue(current.uniqueLeadsWorked, previous.uniqueLeadsWorked),
      callsAnswered: toMetricValue(current.callsAnswered, previous.callsAnswered),
      answerRate: toMetricValue(
        answerRate(current.callsAnswered, current.callsMade), answerRate(previous.callsAnswered, previous.callsMade),
        current.callsAnswered, current.callsMade,
      ),
      connectedSeconds: toMetricValue(current.connectedSeconds, previous.connectedSeconds),
      avgDurationSeconds: toMetricValue(
        avgConnectedDurationSeconds(current.connectedSeconds, current.callsAnswered),
        avgConnectedDurationSeconds(previous.connectedSeconds, previous.callsAnswered),
      ),
      positiveResults: toMetricValue(current.positiveResults, previous.positiveResults),
      wrapUpRate: toMetricValue(
        wrapUpRate(current.wrapUpsCompleted, current.callsAnswered), wrapUpRate(previous.wrapUpsCompleted, previous.callsAnswered),
        current.wrapUpsCompleted, current.callsAnswered,
      ),
      activeSdrs: toMetricValue(current.activeSdrCount, previous.activeSdrCount),
      // Fila é um retrato do momento, não do período — não faz sentido comparar com o passado.
      leadsInQueue: { value: leadsInQueue, previousValue: null, changeAbsolute: null, changePercent: null },
    };

    const totalOutcomes = outcomeRows.reduce((sum, row) => sum + row.count, 0);
    const outcomes: MetricsBreakdownItem[] = outcomeRows.map((row) => ({
      code: row.code,
      label: row.code === NO_RESULT_CODE ? 'Sem resultado' : CALL_RESULT_CATALOG[row.code as CallResultCode]?.label ?? row.code,
      count: row.count,
      percent: safeRate(row.count, totalOutcomes),
    }));

    const totalPipeline = pipelineRows.reduce((sum, row) => sum + row.count, 0);
    const pipeline: MetricsBreakdownItem[] = pipelineRows.map((row) => ({
      code: row.code,
      label: row.code === NO_STAGE_CODE ? 'Sem etapa' : PIPELINE_STAGE_CATALOG[row.code as PipelineStageCode]?.label ?? row.code,
      count: row.count,
      percent: safeRate(row.count, totalPipeline),
    }));

    const trends = this.buildTrendPoints(trendRows);
    const funnel = this.buildFunnelStages(current.uniqueLeadsWorked, funnelCounts);
    const folderRankingForAlerts = this.mapFolderRanking(folderRows);
    const numberRankingForAlerts = this.mapNumberRanking(numberRows);
    const queueStalled = Number(realtime.leads.ready ?? 0) > 0 && realtime.activeCalls === 0 && Number(realtime.sdr.available ?? 0) === 0;
    const goalsBehind = activeGoals
      .filter((goal) => goal.progress.trend === 'behind')
      .map((goal) => ({
        label: goal.scope === 'organization' ? 'Organização' : goal.scopeName ?? (goal.scope === 'sdr' ? 'SDR' : 'Pasta'),
        metricLabel: goal.metricLabel,
        progressPercent: goal.progress.progressPercent,
      }));
    const alerts = buildAlerts({
      current,
      previous,
      realtime: { activeCalls: realtime.activeCalls, sdrsAvailable: Number(realtime.sdr.available ?? 0), leadsReady: Number(realtime.leads.ready ?? 0), numbersInQuarantine: Number(realtime.numbers.quarantine ?? 0), queueStalled },
      folders: folderRankingForAlerts.map((folder) => ({ name: folder.name, isActive: folder.isActive, currentQueue: folder.currentQueue })),
      numbers: numberRankingForAlerts.map((number) => ({ label: number.label, failed: number.failed })),
      openWrapUps: openWrapUpRows.map((row) => ({ sdrName: row.sdr_name, minutesOpen: Math.floor((now.getTime() - new Date(row.started_at).getTime()) / 60_000) })),
      goalsBehind,
    });

    return {
      period: { from: periodStart.toISOString(), to: periodEnd.toISOString(), timezone },
      comparison: { from: compareStart.toISOString(), to: compareEnd.toISOString(), available: true },
      freshness: { generatedAt: now.toISOString(), dataThrough: now.toISOString(), delayed: false },
      filters: this.echoFilters(query),
      kpis,
      trends,
      trendsGranularity: granularity,
      funnel,
      outcomes,
      pipeline,
      alerts,
      realtime: {
        asOf: now.toISOString(),
        activeCalls: realtime.activeCalls,
        sdrsAvailable: Number(realtime.sdr.available ?? 0),
        sdrsInCall: Number(realtime.sdr.in_call ?? 0),
        sdrsInWrapUp: Number(realtime.sdr.post_call ?? 0),
        sdrsOffline: Number(realtime.sdr.offline ?? 0),
        leadsReady: Number(realtime.leads.ready ?? 0),
        leadsWaiting: Number(realtime.leads.waiting ?? 0),
        numbersConnected: Number(realtime.numbers.connected ?? 0),
        numbersUnavailable: Number(realtime.numbers.unavailable ?? 0),
        numbersInCooldown: Number(realtime.numbers.cooldown ?? 0),
        numbersInQuarantine: Number(realtime.numbers.quarantine ?? 0),
        queueStalled,
      },
    };
  }

  async heatmap(tenantId: string, query: MetricsSummaryQueryDto): Promise<{ period: { from: string; to: string; timezone: string }; cells: MetricsHeatmapCell[] }> {
    const { timezone, periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const rows = await this.repo.heatmapCells(tenantId, periodStart, periodEnd, filters, timezone);
    const byKey = new Map(rows.map((row) => [`${row.day_of_week}:${row.hour}`, row]));
    const cells: MetricsHeatmapCell[] = [];
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      for (let hour = 0; hour < 24; hour++) {
        const row = byKey.get(`${dayOfWeek}:${hour}`);
        const calls = row?.calls ?? 0;
        const answered = row?.answered ?? 0;
        const positive = row?.positive ?? 0;
        const failed = row?.failed ?? 0;
        cells.push({ dayOfWeek, hour, calls, answered, positiveResults: positive, failed, answerRate: safeRate(answered, calls), positiveRate: safeRate(positive, calls), failureRate: safeRate(failed, calls) });
      }
    }
    return { period: { from: periodStart.toISOString(), to: periodEnd.toISOString(), timezone }, cells };
  }

  async sdrRanking(tenantId: string, query: MetricsSummaryQueryDto): Promise<MetricsSdrRanking[]> {
    const { periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const rows = await this.repo.sdrRanking(tenantId, periodStart, periodEnd, filters);
    return rows.map((row) => ({
      sdrId: row.id,
      name: row.name,
      status: row.state,
      available: Boolean(row.available),
      callsMade: Number(row.calls_made),
      uniqueLeadsWorked: Number(row.unique_leads_worked),
      callsAnswered: Number(row.calls_answered),
      answerRate: answerRate(Number(row.calls_answered), Number(row.calls_made)),
      connectedSeconds: Number(row.connected_seconds),
      avgDurationSeconds: avgConnectedDurationSeconds(Number(row.connected_seconds), Number(row.calls_answered)),
      positiveResults: Number(row.positive_results),
      stageAdvances: Number(row.stage_advances),
      wrapUpsCompleted: Number(row.wrap_ups_completed),
      wrapUpRate: wrapUpRate(Number(row.wrap_ups_completed), Number(row.calls_answered)),
    }));
  }

  async folderRanking(tenantId: string, query: MetricsSummaryQueryDto): Promise<MetricsFolderRanking[]> {
    const { periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const rows = await this.repo.folderRanking(tenantId, periodStart, periodEnd, filters);
    return this.mapFolderRanking(rows);
  }

  async numberRanking(tenantId: string, query: MetricsSummaryQueryDto): Promise<MetricsNumberRanking[]> {
    const { periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const rows = await this.repo.numberRanking(tenantId, periodStart, periodEnd, filters);
    return this.mapNumberRanking(rows);
  }

  async callsDrilldown(tenantId: string, query: MetricsSummaryQueryDto & { limit?: string; offset?: string }): Promise<MetricsPage<import('./metrics.types').MetricsCallDrilldownItem>> {
    const { periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const { limit, offset } = this.paginationParams(query);
    const { items, total } = await this.repo.callsDrilldown(tenantId, periodStart, periodEnd, filters, limit, offset);
    return {
      items: items.map((row: any) => ({
        callId: row.id,
        status: row.status,
        outcome: row.outcome,
        failureReason: row.failure_reason,
        callResult: row.call_result,
        pipelineStage: row.pipeline_stage,
        source: row.source,
        attemptNumber: row.attempt_number,
        createdAt: new Date(row.created_at).toISOString(),
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
        endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
        durationSeconds: row.duration_seconds,
        ringDurationSeconds: row.ring_duration_seconds,
        connectedDurationSeconds: row.connected_duration_seconds,
        wrapUpCompletedAt: row.wrap_up_completed_at ? new Date(row.wrap_up_completed_at).toISOString() : null,
        notes: row.notes,
        leadId: row.lead_id,
        leadName: row.lead_name,
        leadPhone: row.lead_phone,
        folderId: row.folder_id,
        folderName: row.folder_name,
        sdrId: row.sdr_id,
        sdrName: row.sdr_name,
        numberId: row.number_id,
        numberLabel: row.number_label,
      })),
      total, limit, offset,
    };
  }

  async leadsDrilldown(tenantId: string, query: { folderIds?: string[]; pipelineStages?: string[]; limit?: string; offset?: string }): Promise<MetricsPage<import('./metrics.types').MetricsLeadDrilldownItem>> {
    const { limit, offset } = this.paginationParams(query);
    const { items, total } = await this.repo.leadsDrilldown(tenantId, query.folderIds, query.pipelineStages, limit, offset);
    return {
      items: items.map((row: any) => ({
        leadId: row.id,
        name: row.name,
        phone: row.phone,
        status: row.status,
        pipelineStage: row.pipeline_stage,
        attempts: row.attempts,
        doNotCall: row.do_not_call,
        nextEligibleAt: new Date(row.next_eligible_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
        folderId: row.folder_id,
        folderName: row.folder_name,
      })),
      total, limit, offset,
    };
  }

  async funnel(tenantId: string, query: MetricsSummaryQueryDto): Promise<{ period: { from: string; to: string; timezone: string }; stages: MetricsFunnelStage[] }> {
    const { timezone, periodStart, periodEnd, filters } = await this.resolvePeriod(tenantId, query);
    const [current, funnelCounts] = await Promise.all([
      this.repo.callAggregates(tenantId, periodStart, periodEnd, filters),
      this.repo.funnelCounts(tenantId, periodStart, periodEnd, filters),
    ]);
    return { period: { from: periodStart.toISOString(), to: periodEnd.toISOString(), timezone }, stages: this.buildFunnelStages(current.uniqueLeadsWorked, funnelCounts) };
  }

  async trends(tenantId: string, query: MetricsSummaryQueryDto): Promise<{ period: { from: string; to: string; timezone: string }; granularity: TrendGranularity; points: MetricsTrendPoint[] }> {
    const { timezone, periodStart, periodEnd, rangeDays, filters } = await this.resolvePeriod(tenantId, query);
    const granularity = autoGranularity(rangeDays);
    const rows = await this.repo.trends(tenantId, periodStart, periodEnd, filters, timezone, granularity);
    return { period: { from: periodStart.toISOString(), to: periodEnd.toISOString(), timezone }, granularity, points: this.buildTrendPoints(rows) };
  }
}
