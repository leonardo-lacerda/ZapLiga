import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ACTIVE_CALL_STATUSES, CONNECTED_NUMBER_STATUSES, CONVERSION_CALL_RESULT_CODES, CONVERSION_PIPELINE_STAGE_CODES, NO_RESULT_CODE, NO_STAGE_CODE, POSITIVE_CALL_RESULT_CODES } from './metrics.definitions';
import { civilDateInTimezone, dayRangeInTimezone, lastCompleteDayInRange, shiftDateStr } from './metrics.formulas';
import { MetricsSource } from './metrics.types';

export type TrendGranularity = 'hour' | 'day' | 'week';

export type CallFilters = {
  folderIds?: string[];
  sdrIds?: string[];
  numberIds?: string[];
  source?: MetricsSource;
  callResults?: string[];
  pipelineStages?: string[];
  statuses?: string[];
};

export type CallAggregates = {
  callsMade: number;
  uniqueLeadsWorked: number;
  callsAnswered: number;
  connectedSeconds: number;
  wrapUpsCompleted: number;
  positiveResults: number;
  activeSdrCount: number;
  failedCalls: number;
};

/**
 * Monta o WHERE de `calls` a partir de filtros vindos do cliente sem jamais
 * interpolar valores no SQL — todo valor de filtro vira parâmetro (plano
 * seção 7.3: "não permitir que filtros vindos do cliente alterem SQL
 * diretamente"). Colunas sempre prefixadas com `c.` — `calls` deve ser
 * referenciada como `calls c` em toda query que usa este WHERE, mesmo sem
 * JOIN, porque `callsDrilldown` reaproveita o mesmo WHERE dentro de uma
 * query com JOIN em outras tabelas que também têm `tenant_id`/`status`/etc.
 * (sem o prefixo, essas colunas ficam ambíguas assim que há JOIN).
 */
/**
 * Como `byArray`, mas trata `nullSentinel` (ex.: "sem_resultado") como
 * `coluna IS NULL` em vez de tentar casar a string contra a coluna — sem
 * isso, filtrar/fazer drilldown pelo agrupamento "sem resultado"/"sem etapa"
 * (que representa `call_result`/`pipeline_stage` NULL) nunca encontra nada.
 */
function pushNullableArrayClause(values: unknown[], clauses: string[], column: string, list: string[] | undefined, nullSentinel: string) {
  if (!list?.length) return;
  const hasNull = list.includes(nullSentinel);
  const rest = list.filter((code) => code !== nullSentinel);
  if (hasNull && rest.length) {
    values.push(rest);
    clauses.push(`(${column} IS NULL OR ${column} = ANY($${values.length}::text[]))`);
  } else if (hasNull) {
    clauses.push(`${column} IS NULL`);
  } else {
    values.push(rest);
    clauses.push(`${column} = ANY($${values.length}::text[])`);
  }
}

/** Nenhum filtro de cliente aplicado — só nesse caso o rollup diário (uma linha por tenant/dia, sem dimensão) pode servir `trends()` (plano seção 13, Fase 8, item 1). */
function hasAnyCallFilter(filters: CallFilters): boolean {
  return Boolean(
    filters.folderIds?.length || filters.sdrIds?.length || filters.numberIds?.length
    || (filters.source && filters.source !== 'all')
    || filters.callResults?.length || filters.pipelineStages?.length || filters.statuses?.length,
  );
}

function buildCallsWhere(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
  const values: unknown[] = [tenantId, startUtc.toISOString(), endUtc.toISOString()];
  const clauses = ['c.tenant_id = $1', 'c.created_at >= $2', 'c.created_at <= $3'];
  const byArray = (column: string, list?: string[]) => {
    if (!list?.length) return;
    values.push(list);
    clauses.push(`c.${column} = ANY($${values.length}::text[])`);
  };
  byArray('folder_id', filters.folderIds);
  byArray('sdr_id', filters.sdrIds);
  byArray('number_id', filters.numberIds);
  pushNullableArrayClause(values, clauses, 'c.call_result', filters.callResults, NO_RESULT_CODE);
  pushNullableArrayClause(values, clauses, 'c.pipeline_stage', filters.pipelineStages, NO_STAGE_CODE);
  byArray('status', filters.statuses);
  if (filters.source && filters.source !== 'all') {
    values.push(filters.source);
    clauses.push(`c.source = $${values.length}`);
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, values };
}

@Injectable()
export class MetricsRepository {
  constructor(private readonly db: DatabaseService) {}

  async callAggregates(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters): Promise<CallAggregates> {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const positiveParamIndex = values.length + 1;
    const result = await this.db.query(`
      SELECT
        count(*)::int AS calls_made,
        count(DISTINCT lead_id)::int AS unique_leads_worked,
        count(DISTINCT sdr_id)::int AS active_sdr_count,
        count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS calls_answered,
        COALESCE(sum(connected_duration_seconds) FILTER (WHERE connected_at IS NOT NULL), 0)::int AS connected_seconds,
        count(*) FILTER (WHERE connected_at IS NOT NULL AND wrap_up_completed_at IS NOT NULL)::int AS wrap_ups_completed,
        count(*) FILTER (WHERE call_result = ANY($${positiveParamIndex}::text[]))::int AS positive_results,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_calls
      FROM calls c
      ${where}
    `, [...values, POSITIVE_CALL_RESULT_CODES]);
    const row = result.rows[0] ?? {};
    return {
      callsMade: Number(row.calls_made ?? 0),
      uniqueLeadsWorked: Number(row.unique_leads_worked ?? 0),
      callsAnswered: Number(row.calls_answered ?? 0),
      connectedSeconds: Number(row.connected_seconds ?? 0),
      wrapUpsCompleted: Number(row.wrap_ups_completed ?? 0),
      positiveResults: Number(row.positive_results ?? 0),
      activeSdrCount: Number(row.active_sdr_count ?? 0),
      failedCalls: Number(row.failed_calls ?? 0),
    };
  }

  async outcomeBreakdown(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const codeIndex = values.length + 1;
    const result = await this.db.query(`
      SELECT COALESCE(call_result, $${codeIndex}) AS code, count(*)::int AS count
      FROM calls c ${where}
      GROUP BY COALESCE(call_result, $${codeIndex})
      ORDER BY count DESC
    `, [...values, NO_RESULT_CODE]);
    return result.rows as { code: string; count: number }[];
  }

  async pipelineBreakdown(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const codeIndex = values.length + 1;
    const result = await this.db.query(`
      SELECT COALESCE(pipeline_stage, $${codeIndex}) AS code, count(*)::int AS count
      FROM calls c ${where}
      GROUP BY COALESCE(pipeline_stage, $${codeIndex})
      ORDER BY count DESC
    `, [...values, NO_STAGE_CODE]);
    return result.rows as { code: string; count: number }[];
  }

  async tenantTimezone(tenantId: string): Promise<string | null> {
    const result = await this.db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId]);
    return result.rows[0]?.timezone ?? null;
  }

  async leadsInQueueCount(tenantId: string, folderIds?: string[]) {
    const values: unknown[] = [tenantId];
    let folderClause = '';
    if (folderIds?.length) { values.push(folderIds); folderClause = `AND folder_id = ANY($${values.length}::text[])`; }
    const result = await this.db.query(`
      SELECT count(*)::int AS count FROM leads
      WHERE tenant_id = $1 ${folderClause}
        AND do_not_call = false AND status IN ('queued', 'retry_wait') AND next_eligible_at <= now()
    `, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  async realtimeSnapshot(tenantId: string) {
    const [sdrRow, numberRow, activeCallsRow, leadsRow] = await Promise.all([
      this.db.query(`
        SELECT
          count(*) FILTER (WHERE available = true AND state = 'available')::int AS available,
          count(*) FILTER (WHERE state = 'in_call')::int AS in_call,
          count(*) FILTER (WHERE state = 'post_call')::int AS post_call,
          count(*) FILTER (WHERE state = 'offline')::int AS offline
        FROM sdrs WHERE tenant_id = $1
      `, [tenantId]),
      this.db.query(`
        SELECT
          count(*) FILTER (WHERE status = ANY($2::text[]) AND (flagged_until IS NULL OR flagged_until <= now())
            AND (last_call_ended_at IS NULL OR last_call_ended_at <= now() - (cooldown_seconds * interval '1 second')))::int AS connected,
          count(*) FILTER (WHERE flagged_until IS NOT NULL AND flagged_until > now())::int AS quarantine,
          count(*) FILTER (WHERE (flagged_until IS NULL OR flagged_until <= now()) AND status = ANY($2::text[])
            AND last_call_ended_at IS NOT NULL AND last_call_ended_at > now() - (cooldown_seconds * interval '1 second'))::int AS cooldown,
          count(*) FILTER (WHERE NOT (status = ANY($2::text[])) AND (flagged_until IS NULL OR flagged_until <= now()))::int AS unavailable
        FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'
      `, [tenantId, CONNECTED_NUMBER_STATUSES]),
      this.db.query(`SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND status = ANY($2::text[])`, [tenantId, ACTIVE_CALL_STATUSES]),
      this.db.query(`
        SELECT
          count(*) FILTER (WHERE do_not_call = false AND status IN ('queued', 'retry_wait') AND next_eligible_at <= now())::int AS ready,
          count(*) FILTER (WHERE do_not_call = false AND status IN ('queued', 'retry_wait') AND next_eligible_at > now())::int AS waiting
        FROM leads WHERE tenant_id = $1
      `, [tenantId]),
    ]);
    return {
      sdr: sdrRow.rows[0] ?? { available: 0, in_call: 0, post_call: 0, offline: 0 },
      numbers: numberRow.rows[0] ?? { connected: 0, quarantine: 0, cooldown: 0, unavailable: 0 },
      activeCalls: Number(activeCallsRow.rows[0]?.count ?? 0),
      leads: leadsRow.rows[0] ?? { ready: 0, waiting: 0 },
    };
  }

  /**
   * `trends()` acelerado por `metrics_daily_rollup` (plano seção 13, Fase 8,
   * item 1) quando a granularidade é diária e não há nenhum filtro de
   * cliente aplicado — a visão padrão da tela, e a mais cara de calcular ao
   * vivo em períodos longos. Com filtro, ou granularidade 'hour'/'week',
   * segue direto em `calls` como antes (o rollup guarda uma única linha por
   * tenant/dia, sem dimensão para servir filtro nem para somar corretamente
   * `unique_leads_worked` entre dias sem contar duas vezes o mesmo lead).
   *
   * Dias completos (antes de "hoje" no fuso do tenant) vêm do rollup; o dia
   * corrente — e qualquer dia sem linha de rollup, por qualquer motivo —
   * sempre é calculado ao vivo a partir de `calls`. Isso cobre sozinho o
   * requisito de "fallback quando agregações estiverem atrasadas": não há
   * uma janela de atraso a esperar, porque o dado ao vivo nunca é
   * substituído por um rollup potencialmente desatualizado.
   */
  async trends(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters, timezone: string, granularity: TrendGranularity) {
    if (granularity === 'day' && !hasAnyCallFilter(filters)) {
      const rows = await this.trendsFromDailyRollup(tenantId, startUtc, endUtc, timezone);
      if (rows) return rows;
    }
    return this.trendsRaw(tenantId, startUtc, endUtc, filters, timezone, granularity);
  }

  private async trendsRaw(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters, timezone: string, granularity: TrendGranularity) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const tzIndex = values.length + 1;
    const granularityIndex = values.length + 2;
    const result = await this.db.query(`
      SELECT
        date_trunc($${granularityIndex}, created_at AT TIME ZONE $${tzIndex}) AT TIME ZONE $${tzIndex} AS bucket,
        count(*)::int AS calls_made,
        count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS calls_answered,
        count(DISTINCT lead_id)::int AS unique_leads_worked,
        count(*) FILTER (WHERE call_result = ANY($${granularityIndex + 1}::text[]))::int AS positive_results,
        COALESCE(sum(connected_duration_seconds) FILTER (WHERE connected_at IS NOT NULL), 0)::int AS connected_seconds
      FROM calls c ${where}
      GROUP BY 1
      ORDER BY 1
    `, [...values, timezone, granularity, POSITIVE_CALL_RESULT_CODES]);
    return result.rows as { bucket: Date; calls_made: number; calls_answered: number; unique_leads_worked: number; positive_results: number; connected_seconds: number }[];
  }

  private async trendsFromDailyRollup(tenantId: string, startUtc: Date, endUtc: Date, timezone: string) {
    const startDay = civilDateInTimezone(startUtc, timezone);
    const endDay = civilDateInTimezone(endUtc, timezone);
    const todayDay = civilDateInTimezone(new Date(), timezone);
    const rollupEndDay = lastCompleteDayInRange(startDay, endDay, todayDay);
    if (rollupEndDay === null) return null; // nada de completo no intervalo — deixa o caminho raw cuidar de tudo (ex.: período é só "hoje").

    const rollupResult = await this.db.query(`
      SELECT day, calls_made, calls_answered, unique_leads_worked, positive_results, connected_seconds
      FROM metrics_daily_rollup WHERE tenant_id = $1 AND day >= $2 AND day <= $3 ORDER BY day
    `, [tenantId, startDay, rollupEndDay]);
    const rollupPoints = rollupResult.rows.map((row) => ({
      bucket: dayRangeInTimezone(row.day as string, timezone).startUtc,
      calls_made: Number(row.calls_made),
      calls_answered: Number(row.calls_answered),
      unique_leads_worked: Number(row.unique_leads_worked),
      positive_results: Number(row.positive_results),
      connected_seconds: Number(row.connected_seconds),
    }));

    if (rollupEndDay >= endDay) return rollupPoints;
    const remainderStartDay = shiftDateStr(rollupEndDay, 1);
    const { startUtc: remainderStartUtc } = dayRangeInTimezone(remainderStartDay, timezone);
    const remainderPoints = await this.trendsRaw(tenantId, remainderStartUtc, endUtc, {}, timezone, 'day');
    return [...rollupPoints, ...remainderPoints];
  }

  /** Reprocessamento idempotente (plano seção 13, Fase 8, item 2): recalcula do zero cada dia do intervalo — chamar de novo não duplica nada. */
  async reprocessDailyRollup(tenantId: string, fromDay: string, toDay: string): Promise<{ daysProcessed: number }> {
    const result = await this.db.query(`SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day`, [fromDay, toDay]);
    for (const row of result.rows) {
      await this.db.query('SELECT refresh_metrics_daily_rollup($1, $2)', [tenantId, row.day]);
    }
    return { daysProcessed: result.rows.length };
  }

  async funnelCounts(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const posIndex = values.length + 1;
    const convResultIndex = values.length + 2;
    const convStageIndex = values.length + 3;
    const callStages = await this.db.query(`
      SELECT
        count(DISTINCT lead_id) FILTER (WHERE connected_at IS NOT NULL)::int AS leads_answered,
        count(DISTINCT lead_id) FILTER (WHERE wrap_up_completed_at IS NOT NULL)::int AS leads_wrapped_up,
        count(DISTINCT lead_id) FILTER (WHERE call_result = ANY($${posIndex}::text[]))::int AS leads_positive,
        count(DISTINCT lead_id) FILTER (WHERE call_result = ANY($${convResultIndex}::text[]) OR pipeline_stage = ANY($${convStageIndex}::text[]))::int AS leads_converted
      FROM calls c ${where}
    `, [...values, POSITIVE_CALL_RESULT_CODES, CONVERSION_CALL_RESULT_CODES, CONVERSION_PIPELINE_STAGE_CODES]);

    const availableValues: unknown[] = [tenantId, endUtc.toISOString()];
    let availableFolderClause = '';
    if (filters.folderIds?.length) { availableValues.push(filters.folderIds); availableFolderClause = `AND folder_id = ANY($${availableValues.length}::text[])`; }
    const available = await this.db.query(`
      SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND do_not_call = false AND created_at <= $2 ${availableFolderClause}
    `, availableValues);

    const advancedValues: unknown[] = [tenantId, startUtc.toISOString(), endUtc.toISOString()];
    let advancedFolderClause = '';
    if (filters.folderIds?.length) { advancedValues.push(filters.folderIds); advancedFolderClause = `AND l.folder_id = ANY($${advancedValues.length}::text[])`; }
    const advanced = await this.db.query(`
      SELECT count(DISTINCT h.lead_id)::int AS count
      FROM lead_stage_history h
      JOIN leads l ON l.tenant_id = h.tenant_id AND l.id = h.lead_id
      WHERE h.tenant_id = $1 AND h.created_at >= $2 AND h.created_at <= $3 AND h.source = 'wrap_up' AND h.from_stage IS DISTINCT FROM h.to_stage ${advancedFolderClause}
    `, advancedValues);

    const row = callStages.rows[0] ?? {};
    return {
      leadsAvailable: Number(available.rows[0]?.count ?? 0),
      leadsAnswered: Number(row.leads_answered ?? 0),
      leadsWrappedUp: Number(row.leads_wrapped_up ?? 0),
      leadsPositive: Number(row.leads_positive ?? 0),
      leadsAdvanced: Number(advanced.rows[0]?.count ?? 0),
      leadsConverted: Number(row.leads_converted ?? 0),
    };
  }

  async heatmapCells(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters, timezone: string) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const tzIndex = values.length + 1;
    const posIndex = values.length + 2;
    const result = await this.db.query(`
      SELECT
        EXTRACT(DOW FROM created_at AT TIME ZONE $${tzIndex})::int AS day_of_week,
        EXTRACT(HOUR FROM created_at AT TIME ZONE $${tzIndex})::int AS hour,
        count(*)::int AS calls,
        count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered,
        count(*) FILTER (WHERE call_result = ANY($${posIndex}::text[]))::int AS positive,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM calls c ${where}
      GROUP BY 1, 2
    `, [...values, timezone, POSITIVE_CALL_RESULT_CODES]);
    return result.rows as { day_of_week: number; hour: number; calls: number; answered: number; positive: number; failed: number }[];
  }

  async sdrRanking(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const values: unknown[] = [tenantId, startUtc.toISOString(), endUtc.toISOString()];
    const callClauses = ['c.tenant_id = s.tenant_id', 'c.sdr_id = s.id', 'c.created_at >= $2', 'c.created_at <= $3'];
    const byArray = (column: string, list?: string[]) => {
      if (!list?.length) return;
      values.push(list);
      callClauses.push(`c.${column} = ANY($${values.length}::text[])`);
    };
    byArray('folder_id', filters.folderIds);
    byArray('number_id', filters.numberIds);
    pushNullableArrayClause(values, callClauses, 'c.call_result', filters.callResults, NO_RESULT_CODE);
    pushNullableArrayClause(values, callClauses, 'c.pipeline_stage', filters.pipelineStages, NO_STAGE_CODE);
    byArray('status', filters.statuses);
    if (filters.source && filters.source !== 'all') { values.push(filters.source); callClauses.push(`c.source = $${values.length}`); }
    let sdrIdClause = '';
    if (filters.sdrIds?.length) { values.push(filters.sdrIds); sdrIdClause = `AND s.id = ANY($${values.length}::text[])`; }
    const posIndex = values.length + 1;
    const result = await this.db.query(`
      SELECT s.id, s.name, s.state, s.available,
        count(c.id)::int AS calls_made,
        count(DISTINCT c.lead_id)::int AS unique_leads_worked,
        count(c.id) FILTER (WHERE c.connected_at IS NOT NULL)::int AS calls_answered,
        COALESCE(sum(c.connected_duration_seconds) FILTER (WHERE c.connected_at IS NOT NULL), 0)::int AS connected_seconds,
        count(c.id) FILTER (WHERE c.call_result = ANY($${posIndex}::text[]))::int AS positive_results,
        count(c.id) FILTER (WHERE c.connected_at IS NOT NULL AND c.wrap_up_completed_at IS NOT NULL)::int AS wrap_ups_completed,
        COALESCE(adv.count, 0)::int AS stage_advances
      FROM sdrs s
      LEFT JOIN calls c ON ${callClauses.join(' AND ')}
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count FROM lead_stage_history h
        JOIN calls hc ON hc.tenant_id = h.tenant_id AND hc.id = h.call_id
        WHERE hc.sdr_id = s.id AND h.tenant_id = s.tenant_id AND h.created_at >= $2 AND h.created_at <= $3 AND h.source = 'wrap_up' AND h.from_stage IS DISTINCT FROM h.to_stage
      ) adv ON true
      WHERE s.tenant_id = $1 ${sdrIdClause}
      GROUP BY s.id, adv.count
      ORDER BY calls_made DESC, s.name ASC
    `, [...values, POSITIVE_CALL_RESULT_CODES]);
    return result.rows;
  }

  async folderRanking(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const values: unknown[] = [tenantId, startUtc.toISOString(), endUtc.toISOString()];
    const callClauses = ['c.tenant_id = f.tenant_id', 'c.folder_id = f.id', 'c.created_at >= $2', 'c.created_at <= $3'];
    const byArray = (column: string, list?: string[]) => {
      if (!list?.length) return;
      values.push(list);
      callClauses.push(`c.${column} = ANY($${values.length}::text[])`);
    };
    byArray('sdr_id', filters.sdrIds);
    byArray('number_id', filters.numberIds);
    pushNullableArrayClause(values, callClauses, 'c.call_result', filters.callResults, NO_RESULT_CODE);
    pushNullableArrayClause(values, callClauses, 'c.pipeline_stage', filters.pipelineStages, NO_STAGE_CODE);
    byArray('status', filters.statuses);
    if (filters.source && filters.source !== 'all') { values.push(filters.source); callClauses.push(`c.source = $${values.length}`); }
    let folderIdClause = '';
    if (filters.folderIds?.length) { values.push(filters.folderIds); folderIdClause = `AND f.id = ANY($${values.length}::text[])`; }
    const posIndex = values.length + 1;
    const convResultIndex = values.length + 2;
    const convStageIndex = values.length + 3;
    const result = await this.db.query(`
      SELECT f.id, f.name, f.is_active,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id) AS total_leads,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id
          AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.next_eligible_at <= now()) AS current_queue,
        count(c.id)::int AS calls_made,
        count(DISTINCT c.lead_id)::int AS unique_leads_worked,
        count(c.id) FILTER (WHERE c.connected_at IS NOT NULL)::int AS calls_answered,
        count(c.id) FILTER (WHERE c.call_result = ANY($${posIndex}::text[]))::int AS positive_results,
        count(c.id) FILTER (WHERE c.call_result = ANY($${convResultIndex}::text[]) OR c.pipeline_stage = ANY($${convStageIndex}::text[]))::int AS conversions,
        COALESCE(adv.count, 0)::int AS stage_advances,
        best_hour.hour AS best_hour
      FROM lead_folders f
      LEFT JOIN calls c ON ${callClauses.join(' AND ')}
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count FROM lead_stage_history h
        JOIN leads hl ON hl.tenant_id = h.tenant_id AND hl.id = h.lead_id
        WHERE hl.folder_id = f.id AND h.tenant_id = f.tenant_id AND h.created_at >= $2 AND h.created_at <= $3 AND h.source = 'wrap_up' AND h.from_stage IS DISTINCT FROM h.to_stage
      ) adv ON true
      LEFT JOIN LATERAL (
        SELECT EXTRACT(HOUR FROM bh.created_at)::int AS hour, count(*) AS calls
        FROM calls bh WHERE bh.tenant_id = f.tenant_id AND bh.folder_id = f.id AND bh.created_at >= $2 AND bh.created_at <= $3
        GROUP BY 1 ORDER BY calls DESC LIMIT 1
      ) best_hour ON true
      WHERE f.tenant_id = $1 ${folderIdClause}
      GROUP BY f.id, adv.count, best_hour.hour
      ORDER BY calls_made DESC, f.name ASC
    `, [...values, POSITIVE_CALL_RESULT_CODES, CONVERSION_CALL_RESULT_CODES, CONVERSION_PIPELINE_STAGE_CODES]);
    return result.rows;
  }

  async numberRanking(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters) {
    const values: unknown[] = [tenantId, startUtc.toISOString(), endUtc.toISOString()];
    const callClauses = ['c.tenant_id = n.tenant_id', 'c.number_id = n.id', 'c.created_at >= $2', 'c.created_at <= $3'];
    const byArray = (column: string, list?: string[]) => {
      if (!list?.length) return;
      values.push(list);
      callClauses.push(`c.${column} = ANY($${values.length}::text[])`);
    };
    byArray('folder_id', filters.folderIds);
    byArray('sdr_id', filters.sdrIds);
    pushNullableArrayClause(values, callClauses, 'c.call_result', filters.callResults, NO_RESULT_CODE);
    pushNullableArrayClause(values, callClauses, 'c.pipeline_stage', filters.pipelineStages, NO_STAGE_CODE);
    byArray('status', filters.statuses);
    if (filters.source && filters.source !== 'all') { values.push(filters.source); callClauses.push(`c.source = $${values.length}`); }
    let numberIdClause = '';
    if (filters.numberIds?.length) { values.push(filters.numberIds); numberIdClause = `AND n.id = ANY($${values.length}::text[])`; }
    const result = await this.db.query(`
      SELECT n.id, n.label, n.status, n.max_concurrent_calls, n.cooldown_seconds, n.last_call_ended_at, n.flagged_until,
        count(c.id)::int AS calls_made,
        count(c.id) FILTER (WHERE c.connected_at IS NOT NULL)::int AS calls_answered,
        count(c.id) FILTER (WHERE c.status = 'failed')::int AS failed,
        (SELECT count(*)::int FROM calls ac WHERE ac.number_id = n.id AND ac.status IN ('reserved', 'dialing', 'media_active')) AS active_calls,
        GREATEST(n.last_call_ended_at, max(c.created_at)) AS last_activity_at
      FROM whatsapp_numbers n
      LEFT JOIN calls c ON ${callClauses.join(' AND ')}
      WHERE n.tenant_id = $1 AND n.status <> 'removed' ${numberIdClause}
      GROUP BY n.id
      ORDER BY calls_made DESC, n.label ASC
    `, values);
    return result.rows;
  }

  async callsDrilldown(tenantId: string, startUtc: Date, endUtc: Date, filters: CallFilters, limit: number, offset: number) {
    const { where, values } = buildCallsWhere(tenantId, startUtc, endUtc, filters);
    const total = await this.db.query(`SELECT count(*)::int AS total FROM calls c ${where}`, values);
    const items = await this.db.query(`
      SELECT c.id, c.status, c.outcome, c.failure_reason, c.call_result, c.pipeline_stage, c.source, c.attempt_number,
        c.created_at, c.started_at, c.connected_at, c.ended_at, c.duration_seconds, c.ring_duration_seconds, c.connected_duration_seconds,
        c.wrap_up_completed_at, c.notes,
        l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
        f.id AS folder_id, f.name AS folder_name,
        s.id AS sdr_id, s.name AS sdr_name,
        n.id AS number_id, n.label AS number_label
      FROM calls c
      JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
      JOIN lead_folders f ON f.tenant_id = c.tenant_id AND f.id = c.folder_id
      JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id
      JOIN whatsapp_numbers n ON n.id = c.number_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `, [...values, limit, offset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0) };
  }

  async leadsDrilldown(tenantId: string, folderIds: string[] | undefined, pipelineStages: string[] | undefined, limit: number, offset: number) {
    const values: unknown[] = [tenantId];
    const clauses = ['l.tenant_id = $1'];
    if (folderIds?.length) { values.push(folderIds); clauses.push(`l.folder_id = ANY($${values.length}::text[])`); }
    if (pipelineStages?.length) { values.push(pipelineStages); clauses.push(`l.pipeline_stage = ANY($${values.length}::text[])`); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = await this.db.query(`SELECT count(*)::int AS total FROM leads l ${where}`, values);
    const items = await this.db.query(`
      SELECT l.id, l.name, l.phone, l.status, l.pipeline_stage, l.attempts, l.do_not_call, l.next_eligible_at, l.created_at,
        f.id AS folder_id, f.name AS folder_name
      FROM leads l
      JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `, [...values, limit, offset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0) };
  }

  /** SDRs presos em pós-atendimento há mais de `minMinutesOpen` — alerta "pós-atendimentos pendentes" (plano seção 6.6). */
  async openWrapUps(tenantId: string, minMinutesOpen: number) {
    const result = await this.db.query(`
      SELECT s.name AS sdr_name, p.started_at
      FROM sdr_pauses p
      JOIN sdrs s ON s.tenant_id = p.tenant_id AND s.id = p.sdr_id
      WHERE p.tenant_id = $1 AND p.pause_type = 'post_call' AND p.ended_at IS NULL
        AND p.started_at <= now() - ($2 * interval '1 minute')
      ORDER BY p.started_at ASC
    `, [tenantId, minMinutesOpen]);
    return result.rows as { sdr_name: string; started_at: Date }[];
  }
}
