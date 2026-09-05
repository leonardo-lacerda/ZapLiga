import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { CALL_RESULT_CATALOG, DEFAULT_TENANT_TIMEZONE, PIPELINE_STAGE_CATALOG, POSITIVE_CALL_RESULT_CODES } from '../metrics/metrics.definitions';

export const ANALYTICS_LEARNING_FORMULA_VERSION = 1 as const;
export const ANALYTICS_LEARNING_MIN_SAMPLE_SIZE = 20 as const;
const ANALYTICS_LEARNING_MAX_LINE_FAILURE_DELTA = 0.15;
const ANALYTICS_LEARNING_MAX_SELECTION_CONCENTRATION = 0.8;
const ANALYTICS_LEARNING_MAX_RETRY_SHARE = 0.6;
const MAX_PERIOD_MS = 366 * 24 * 60 * 60 * 1000;
type Reliability = { score: number; status: 'reliable' | 'attention' | 'unreliable' | 'insufficient_data' };
type AggregateRow = { dimension: string; dimension_value: string; calls: number; answered: number; positive: number; failed: number; first_attempt_seconds: number | null; attempts_to_answer: number | null };

const round = (value: number, digits = 4) => Math.round(value * (10 ** digits)) / (10 ** digits);
const asNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

@Injectable()
export class AnalyticsLearningService {
  constructor(private readonly db: DatabaseService, @Optional() private readonly flags?: FeatureFlagsService) {}

  private period(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new BadRequestException('Período de aprendizado inválido');
    if (end.getTime() - start.getTime() > MAX_PERIOD_MS) throw new BadRequestException('O período máximo de aprendizado é de 366 dias');
    return { start, end };
  }

  private async timezone(tenantId: string) {
    return (await this.db.query('SELECT COALESCE(timezone, $2) AS timezone FROM tenants WHERE id=$1', [tenantId, DEFAULT_TENANT_TIMEZONE])).rows[0]?.timezone ?? DEFAULT_TENANT_TIMEZONE;
  }

  private async reliability(tenantId: string): Promise<Reliability> {
    const row = (await this.db.query('SELECT reliability_score, reliability_status FROM analytics_reconciliation_runs WHERE tenant_id=$1 ORDER BY computed_at DESC LIMIT 1', [tenantId])).rows[0];
    return row ? { score: asNumber(row.reliability_score), status: row.reliability_status } : { score: 0, status: 'insufficient_data' };
  }

  private aggregateQuery(dimension: AggregateRow['dimension'], tenantId: string, start: Date, end: Date, timezone: string) {
    const grouping: Record<string, string> = {
      tenant: `'all'`,
      day_hour: `concat(extract(dow from c.created_at at time zone vars.timezone)::int, ':', lpad(extract(hour from c.created_at at time zone vars.timezone)::int::text, 2, '0'))`,
      campaign: `coalesce(c.campaign_id, 'legacy')`,
      source: `case when c.source in ('automatico', 'manual', 'inbound') then c.source else 'other' end`,
      recency: `case when l.created_at is null then 'unknown' when extract(epoch from (c.created_at - l.created_at)) < 86400 then '0_1d' when extract(epoch from (c.created_at - l.created_at)) < 604800 then '2_7d' when extract(epoch from (c.created_at - l.created_at)) < 2592000 then '8_30d' else '31d_plus' end`,
      attempt: `case when coalesce(c.attempt_number, 0) <= 1 then 'attempt_1' when c.attempt_number = 2 then 'attempt_2' else 'attempt_3_plus' end`,
      stage: `case when c.pipeline_stage = any(vars.stages) then c.pipeline_stage else 'other' end`,
      line: `coalesce(c.number_id, 'unknown')`,
    };
    return this.db.query(`SELECT $6::text AS dimension, ${grouping[dimension]} AS dimension_value,
        count(*)::int AS calls,
        count(*) filter (where c.connected_at is not null)::int AS answered,
        count(*) filter (where c.call_result = any($7::text[]))::int AS positive,
        count(*) filter (where c.status = 'failed')::int AS failed,
        avg(extract(epoch from (c.created_at - l.created_at))) filter (where c.attempt_number = 1 and l.created_at is not null) AS first_attempt_seconds,
        avg(c.attempt_number) filter (where c.connected_at is not null) AS attempts_to_answer
      FROM calls c LEFT JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_id
      CROSS JOIN (SELECT $4::text AS timezone, $5::text[] AS stages) AS vars
      WHERE c.tenant_id=$1 AND c.created_at >= $2 AND c.created_at < $3
      GROUP BY 1, 2 ORDER BY calls DESC, dimension_value`, [tenantId, start.toISOString(), end.toISOString(), timezone, Object.keys(PIPELINE_STAGE_CATALOG), dimension, POSITIVE_CALL_RESULT_CODES]);
  }

  private snapshot(row: AggregateRow, reliability: Reliability, start: Date, end: Date) {
    const calls = Math.max(0, asNumber(row.calls));
    const answered = Math.max(0, asNumber(row.answered));
    const positive = Math.max(0, asNumber(row.positive));
    const failed = Math.max(0, asNumber(row.failed));
    const confidence = calls < ANALYTICS_LEARNING_MIN_SAMPLE_SIZE ? 'insufficient_data' : calls < ANALYTICS_LEARNING_MIN_SAMPLE_SIZE * 2 ? 'directional' : 'reliable';
    return {
      id: randomUUID(), periodStart: start.toISOString(), periodEnd: end.toISOString(), dimension: row.dimension, dimensionValue: String(row.dimension_value), sampleSize: calls,
      rawMetrics: { calls, answered, positive, failed, firstAttemptSeconds: row.first_attempt_seconds == null ? null : round(asNumber(row.first_attempt_seconds), 2), attemptsToAnswer: row.attempts_to_answer == null ? null : round(asNumber(row.attempts_to_answer), 2) },
      smoothedMetrics: { answerRate: round((answered + 1) / (calls + 2)), positiveRate: round((positive + 1) / (calls + 2)), failureRate: round((failed + 1) / (calls + 2)), firstAttemptHours: row.first_attempt_seconds == null ? null : round(asNumber(row.first_attempt_seconds) / 3600, 2), attemptsToAnswer: row.attempts_to_answer == null ? null : round(asNumber(row.attempts_to_answer), 2) },
      confidence, reliabilityScore: reliability.score, reliabilityStatus: reliability.status,
    };
  }

  async rebuild(tenantId: string, from?: string, to?: string) {
    const { start, end } = this.period(from, to);
    const timezone = await this.timezone(tenantId);
    const reliability = await this.reliability(tenantId);
    const dimensions = ['tenant', 'day_hour', 'campaign', 'source', 'recency', 'attempt', 'stage', 'line'] as const;
    const results = await Promise.all(dimensions.map((dimension) => this.aggregateQuery(dimension, tenantId, start, end, timezone)));
    const snapshots = results.flatMap((result) => result.rows.map((row: AggregateRow) => this.snapshot(row, reliability, start, end)));
    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM analytics_tenant_signal_snapshots WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3', [tenantId, start.toISOString(), end.toISOString()]);
      for (const item of snapshots) {
        await client.query(`INSERT INTO analytics_tenant_signal_snapshots
          (id, tenant_id, period_start, period_end, granularity, dimension, dimension_value, sample_size, raw_metrics, smoothed_metrics, confidence, reliability_score, reliability_status, formula_version)
          VALUES ($1,$2,$3,$4,'period',$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`, [item.id, tenantId, item.periodStart, item.periodEnd, item.dimension, item.dimensionValue, item.sampleSize, JSON.stringify(item.rawMetrics), JSON.stringify(item.smoothedMetrics), item.confidence, item.reliabilityScore, item.reliabilityStatus, ANALYTICS_LEARNING_FORMULA_VERSION]);
      }
      await client.query(`INSERT INTO analytics_tenant_learning_runs
        (id, tenant_id, period_start, period_end, minimum_sample_size, snapshot_count, reliability_score, reliability_status, status, details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [randomUUID(), tenantId, start.toISOString(), end.toISOString(), ANALYTICS_LEARNING_MIN_SAMPLE_SIZE, snapshots.length, reliability.score, reliability.status, snapshots.length ? 'completed' : 'insufficient_data', JSON.stringify({ timezone, dimensions })]);
    });
    return { period: { from: start.toISOString(), to: end.toISOString(), timezone }, minimumSampleSize: ANALYTICS_LEARNING_MIN_SAMPLE_SIZE, snapshotCount: snapshots.length, reliability, status: snapshots.length ? 'completed' : 'insufficient_data' };
  }

  private async latestSnapshots(tenantId: string, from?: string, to?: string) {
    let { start, end } = this.period(from, to);
    if (!from && !to) {
      const latest = (await this.db.query('SELECT period_start, period_end FROM analytics_tenant_learning_runs WHERE tenant_id=$1 ORDER BY computed_at DESC LIMIT 1', [tenantId])).rows[0];
      if (latest) { start = new Date(latest.period_start); end = new Date(latest.period_end); }
    }
    const rows = await this.db.query(`SELECT id, period_start, period_end, dimension, dimension_value, sample_size, raw_metrics, smoothed_metrics, confidence, reliability_score, reliability_status, formula_version, computed_at
      FROM analytics_tenant_signal_snapshots WHERE tenant_id=$1 AND period_start=$2 AND period_end=$3 ORDER BY dimension, sample_size DESC, dimension_value`, [tenantId, start.toISOString(), end.toISOString()]);
    return { start, end, rows: rows.rows };
  }

  async aggregates(tenantId: string, from?: string, to?: string, dimension?: string) {
    const result = await this.latestSnapshots(tenantId, from, to);
    const allowed = new Set(['tenant', 'day_hour', 'campaign', 'source', 'recency', 'attempt', 'stage', 'line']);
    const items = result.rows.filter((row) => !dimension || (allowed.has(dimension) && row.dimension === dimension)).map((row) => ({
      id: row.id, dimension: row.dimension, dimensionValue: row.dimension_value, sampleSize: Number(row.sample_size), rawMetrics: row.raw_metrics, smoothedMetrics: row.smoothed_metrics, confidence: row.confidence, reliabilityScore: row.reliability_score == null ? null : Number(row.reliability_score), reliabilityStatus: row.reliability_status, formulaVersion: Number(row.formula_version), computedAt: row.computed_at,
    }));
    return { period: { from: result.start.toISOString(), to: result.end.toISOString() }, minimumSampleSize: ANALYTICS_LEARNING_MIN_SAMPLE_SIZE, items };
  }

  async monitor(tenantId: string, from?: string, to?: string) {
    const result = await this.latestSnapshots(tenantId, from, to);
    const reliability = await this.reliability(tenantId);
    const tenant = result.rows.find((row) => row.dimension === 'tenant' && row.dimension_value === 'all');
    const tenantCalls = Math.max(0, asNumber(tenant?.raw_metrics?.calls));
    const baselineFailureRate = tenantCalls ? asNumber(tenant?.raw_metrics?.failed) / tenantCalls : 0;
    const lineItems = result.rows
      .filter((row) => row.dimension === 'line' && Number(row.sample_size) >= ANALYTICS_LEARNING_MIN_SAMPLE_SIZE)
      .map((row) => {
        const calls = Math.max(0, asNumber(row.raw_metrics?.calls));
        const failureRate = calls ? asNumber(row.raw_metrics?.failed) / calls : 0;
        return { line: row.dimension_value, sampleSize: Number(row.sample_size), failureRate: round(failureRate), failureDelta: round(failureRate - baselineFailureRate) };
      });
    const maxLineFailureDelta = lineItems.length ? Math.max(...lineItems.map((item) => Math.abs(item.failureDelta))) : null;
    const stabilityStatus = reliability.status !== 'reliable' || !lineItems.length
      ? 'insufficient_data'
      : (maxLineFailureDelta ?? 0) > ANALYTICS_LEARNING_MAX_LINE_FAILURE_DELTA ? 'attention' : 'stable';

    const sourceItems = result.rows.filter((row) => row.dimension === 'source');
    const dominantSource = [...sourceItems].sort((left, right) => asNumber(right.raw_metrics?.calls) - asNumber(left.raw_metrics?.calls))[0];
    const dominantCalls = asNumber(dominantSource?.raw_metrics?.calls);
    const concentration = tenantCalls ? round(dominantCalls / tenantCalls) : 0;
    const attemptRows = result.rows.filter((row) => row.dimension === 'attempt');
    const retryCalls = attemptRows
      .filter((row) => ['attempt_2', 'attempt_3_plus'].includes(row.dimension_value))
      .reduce((sum, row) => sum + asNumber(row.raw_metrics?.calls), 0);
    const retryShare = tenantCalls ? round(retryCalls / tenantCalls) : 0;
    const selectionWarnings: string[] = [];
    if (dominantSource && concentration > ANALYTICS_LEARNING_MAX_SELECTION_CONCENTRATION) selectionWarnings.push('A amostra está concentrada em uma única origem observada.');
    if (retryShare > ANALYTICS_LEARNING_MAX_RETRY_SHARE) selectionWarnings.push('A amostra está concentrada em tentativas posteriores.');
    if (reliability.status !== 'reliable') selectionWarnings.push('A reconciliação analítica ainda não sustenta comparação histórica.');
    return {
      period: { from: result.start.toISOString(), to: result.end.toISOString() },
      formulaVersion: ANALYTICS_LEARNING_FORMULA_VERSION,
      minimumSampleSize: ANALYTICS_LEARNING_MIN_SAMPLE_SIZE,
      reliability,
      stability: {
        status: stabilityStatus,
        baselineFailureRate: round(baselineFailureRate),
        maxLineFailureDelta,
        lines: lineItems,
        threshold: ANALYTICS_LEARNING_MAX_LINE_FAILURE_DELTA,
      },
      selectionBias: {
        status: !tenantCalls || reliability.status !== 'reliable' ? 'insufficient_data' : selectionWarnings.length ? 'attention' : 'observed',
        concentration,
        dominantSource: dominantSource?.dimension_value ?? null,
        retryShare,
        warnings: selectionWarnings,
        note: 'Sinais de concentração são alertas descritivos de seleção; não provam causalidade.',
      },
    };
  }

  async insights(tenantId: string, from?: string, to?: string) {
    const result = await this.latestSnapshots(tenantId, from, to);
    const reliability = await this.reliability(tenantId);
    const eligible = reliability.status === 'reliable';
    const candidates = result.rows.filter((row) => Number(row.sample_size) >= ANALYTICS_LEARNING_MIN_SAMPLE_SIZE && row.confidence !== 'insufficient_data' && row.reliability_status === 'reliable');
    const best = (dimension: string, metric: string, direction: 'asc' | 'desc') => [...candidates.filter((row) => row.dimension === dimension)].sort((left, right) => (asNumber(right.smoothed_metrics?.[metric]) - asNumber(left.smoothed_metrics?.[metric])) * (direction === 'desc' ? 1 : -1) || Number(right.sample_size) - Number(left.sample_size))[0];
    const items = eligible ? [
      { type: 'best_time', title: 'Melhor janela de atendimento', row: best('day_hour', 'answerRate', 'desc'), metric: 'answerRate', explanation: 'Maior taxa de atendimento suavizada entre janelas com amostra mínima.' },
      { type: 'campaign_positive_rate', title: 'Campanha com melhor resultado positivo', row: best('campaign', 'positiveRate', 'desc'), metric: 'positiveRate', explanation: 'Resultado positivo suavizado por tentativa, sem concluir causalidade.' },
      { type: 'source_positive_rate', title: 'Origem com melhor resultado positivo', row: best('source', 'positiveRate', 'desc'), metric: 'positiveRate', explanation: 'Comparação descritiva entre origens observadas no período.' },
      { type: 'best_recency', title: 'Recência com melhor atendimento', row: best('recency', 'answerRate', 'desc'), metric: 'answerRate', explanation: 'Faixa de recência associada à maior taxa de atendimento observada.' },
    ].filter((item) => item.row).map((item) => ({ type: item.type, title: item.title, dimension: item.row!.dimension, dimensionValue: item.row!.dimension_value, metric: item.metric, value: asNumber(item.row!.smoothed_metrics?.[item.metric]), sampleSize: Number(item.row!.sample_size), denominator: Number(item.row!.raw_metrics?.calls ?? item.row!.sample_size), confidence: item.row!.confidence, period: { from: result.start.toISOString(), to: result.end.toISOString() }, explanation: item.explanation })) : [];
    return { period: { from: result.start.toISOString(), to: result.end.toISOString() }, minimumSampleSize: ANALYTICS_LEARNING_MIN_SAMPLE_SIZE, reliability, eligible, status: eligible ? (items.length ? 'ready' : 'insufficient_data') : 'insufficient_data', message: eligible ? (items.length ? 'Insights descritivos disponíveis.' : 'Dados insuficientes para formar insights.') : 'Insights históricos desativados até a confiabilidade do analytics atingir o mínimo.', insights: items };
  }

  async shadowSignal(tenantId: string, now = new Date()) {
    if (this.flags && !(await this.flags.enabled(tenantId, 'analytics_learning'))) return null;
    const reliability = await this.reliability(tenantId);
    if (reliability.status !== 'reliable') return null;
    const row = (await this.db.query(`SELECT s.smoothed_metrics, s.sample_size, s.dimension_value, baseline.smoothed_metrics AS baseline_metrics
      FROM analytics_tenant_signal_snapshots s JOIN analytics_tenant_signal_snapshots baseline
        ON baseline.tenant_id=s.tenant_id AND baseline.period_start=s.period_start AND baseline.period_end=s.period_end AND baseline.dimension='tenant' AND baseline.dimension_value='all'
      JOIN tenants t ON t.id=s.tenant_id
      WHERE s.tenant_id=$1 AND s.dimension='day_hour'
        AND s.dimension_value=concat(extract(dow from $2::timestamptz at time zone coalesce(t.timezone, 'America/Sao_Paulo'))::int, ':', lpad(extract(hour from $2::timestamptz at time zone coalesce(t.timezone, 'America/Sao_Paulo'))::int::text, 2, '0'))
      ORDER BY s.computed_at DESC LIMIT 1`, [tenantId, now.toISOString()])).rows[0];
    if (!row || Number(row.sample_size) < ANALYTICS_LEARNING_MIN_SAMPLE_SIZE) return null;
    const delta = asNumber(row.smoothed_metrics?.answerRate) - asNumber(row.baseline_metrics?.answerRate);
    return { dimension: 'day_hour', dimensionValue: row.dimension_value, sampleSize: Number(row.sample_size), boost: Math.max(-1, Math.min(1, delta * 4)), reliability };
  }
}
