import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CanaryRow, computeFindings, DayRow, FallRow, HourRow, LEARNINGS_DEFAULT_DAYS, LINE_LEARNINGS_FORMULA_VERSION, SignalRow, Thresholds } from './line-learnings.rules';
import { DEFAULT_TIMEZONE, LINE_FELL_CAUSES, MAX_PERIOD_DAYS, daysBetween, localDay, shiftDay } from './line-monitor.rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RUNS_LISTED = 30;
// A line moved to another exit this recently is flagged: WhatsApp just saw it log in elsewhere.
const RECENT_MOVE_MINUTES = 60;
const LAST_CALLS = 10;
// A canary pass is followed for this long to see whether the line fell.
const CANARY_FOLLOW_DAYS = 7;

export type Alert = { kind: 'pc_offline' | 'crowded_exit' | 'recently_moved' | 'near_fall_point' | 'many_1005'; numberId?: string; label: string; message: string };

/**
 * Computes and saves the line learnings (line-learnings.rules, `line_learning_runs`) and turns the
 * last saved computation into the Monitor's alerts. A learning-based alert only shows when the
 * learning behind it is past a small sample, so the page never warns without a basis.
 */
@Injectable()
export class LineLearningsService {
  constructor(private readonly db: DatabaseService) {}

  private async timezone(tenantId: string) {
    return (await this.db.query<{ timezone: string }>('SELECT COALESCE(timezone, $2) AS timezone FROM tenants WHERE id = $1', [tenantId, DEFAULT_TIMEZONE])).rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }

  async hasNightlyRun(tenantId: string, day: string) {
    return Boolean((await this.db.query(`SELECT 1 FROM line_learning_runs WHERE tenant_id = $1 AND trigger = 'nightly' AND period_end = $2::date LIMIT 1`, [tenantId, day])).rows[0]);
  }

  async compute(tenantId: string, options: { trigger: 'nightly' | 'manual'; from?: string; to?: string }) {
    const timezone = await this.timezone(tenantId);
    const to = options.to ?? localDay(new Date(), timezone).day;
    const from = options.from ?? shiftDay(to, -(LEARNINGS_DEFAULT_DAYS - 1));
    if (!DAY.test(from) || !DAY.test(to) || from > to) throw new BadRequestException('Período inválido: use AAAA-MM-DD, com a data inicial antes da final');
    if (daysBetween(from, to).length > MAX_PERIOD_DAYS) throw new BadRequestException(`O período máximo é de ${MAX_PERIOD_DAYS} dias`);
    const params = [tenantId, from, to, timezone];
    const range = (column: string) => `${column} >= ($2::date)::timestamp AT TIME ZONE $4 AND ${column} < ($3::date + 1)::timestamp AT TIME ZONE $4`;

    const days = (await this.db.query<DayRow>(`
      SELECT number_id, to_char(day, 'YYYY-MM-DD') AS day, age_days, stealth, device_profile, business, config_estimated, waxum_node,
        calls, answered, short_answered, closed_1005, lost, reconnects, node_moves
      FROM line_daily_stats WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
    `, [tenantId, from, to])).rows;
    const falls = (await this.db.query<FallRow>(`
      SELECT number_id, cause, extract(hour FROM occurred_at AT TIME ZONE $4)::int AS hour, detail->'context' AS context
      FROM line_loss_events WHERE tenant_id = $1 AND cause = ANY($5::text[]) AND ${range('occurred_at')}
    `, [...params, [...LINE_FELL_CAUSES]])).rows;
    const canaries = (await this.db.query<CanaryRow>(`
      SELECT h.number_id, h.actor_type = 'human' AS manual,
        EXISTS (SELECT 1 FROM line_loss_events e WHERE e.tenant_id = h.tenant_id AND e.number_id = h.number_id AND e.cause = ANY($5::text[])
          AND e.occurred_at > h.occurred_at AND e.occurred_at <= h.occurred_at + make_interval(days => $6)) AS fell_after
      FROM number_health_events h WHERE h.tenant_id = $1 AND h.event_type = 'canary_passed' AND ${range('h.occurred_at')}
    `, [...params, [...LINE_FELL_CAUSES], CANARY_FOLLOW_DAYS])).rows;
    const signals = (await this.db.query<SignalRow>(`
      WITH f AS (SELECT number_id, occurred_at FROM line_loss_events WHERE tenant_id = $1 AND cause = ANY($5::text[]) AND ${range('occurred_at')}),
      cs AS (
        SELECT c.id, EXISTS (SELECT 1 FROM f WHERE f.number_id = c.number_id AND f.occurred_at > c.created_at AND f.occurred_at <= c.created_at + interval '24 hours') AS before_fall
        FROM calls c WHERE c.tenant_id = $1 AND NOT c.canary AND ${range('c.created_at')}
      )
      SELECT cs.before_fall, count(*)::int AS calls,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM call_signal_events s WHERE s.call_id = cs.id AND s.kind = 'call_ack' AND s.detail->>'error' IS NOT NULL))::int AS ack_errors,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (SELECT min(s.ms_since_offer) FROM call_signal_events s WHERE s.call_id = cs.id AND s.kind = 'call_receipt'))::numeric)::int AS receipt_ms
      FROM cs GROUP BY cs.before_fall
    `, [...params, [...LINE_FELL_CAUSES]])).rows;
    const hours = (await this.db.query<HourRow>(`
      SELECT extract(hour FROM created_at AT TIME ZONE $4)::int AS hour, count(*)::int AS calls
      FROM calls WHERE tenant_id = $1 AND NOT canary AND ${range('created_at')} GROUP BY 1 ORDER BY 1
    `, params)).rows;

    const result = computeFindings({ days, falls, canaries, signals, hours });
    const run = (await this.db.query(`
      INSERT INTO line_learning_runs (tenant_id, formula_version, period_start, period_end, trigger, sample, findings)
      VALUES ($1, $2, $3::date, $4::date, $5, $6::jsonb, $7::jsonb) RETURNING *
    `, [tenantId, LINE_LEARNINGS_FORMULA_VERSION, from, to, options.trigger, JSON.stringify({ ...result.sample, thresholds: result.thresholds }), JSON.stringify(result.findings)])).rows[0];
    return run;
  }

  async latest(tenantId: string) {
    const run = (await this.db.query('SELECT * FROM line_learning_runs WHERE tenant_id = $1 ORDER BY computed_at DESC LIMIT 1', [tenantId])).rows[0];
    return run ?? null;
  }

  async run(tenantId: string, id: string) {
    const run = (await this.db.query('SELECT * FROM line_learning_runs WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0];
    if (!run) throw new NotFoundException('Cálculo não encontrado');
    return run;
  }

  async runs(tenantId: string) {
    return (await this.db.query(`
      SELECT id, trigger, formula_version, period_start, period_end, computed_at
      FROM line_learning_runs WHERE tenant_id = $1 ORDER BY computed_at DESC LIMIT $2
    `, [tenantId, RUNS_LISTED])).rows;
  }

  /** The Monitor's alerts for the lines and exits it shows now. */
  async alerts(tenantId: string, lines: any[], exits: any[]): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const maxPerPc = Number((await this.db.query('SELECT max_numbers_per_pc FROM egress_settings')).rows[0]?.max_numbers_per_pc ?? 5);
    for (const exit of exits) {
      if (!exit.online && Number(exit.lines) > 0) alerts.push({ kind: 'pc_offline', label: exit.name, message: `${exit.name} está sem internet com ${exit.lines} linha(s) desta empresa.` });
      if (exit.kind === 'pc' && Number(exit.lines) > maxPerPc) alerts.push({ kind: 'crowded_exit', label: exit.name, message: `${exit.name} está com ${exit.lines} linhas, acima de ${maxPerPc} por PC, e todas saem pelo mesmo IP.` });
    }
    const live = lines.filter((line) => line.status !== 'removed' && !line.loss_reason);
    if (!live.length) return alerts;
    const ids = live.map((line) => line.id);
    const facts = (await this.db.query(`
      SELECT n.id,
        (SELECT count(*)::int FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id AND NOT c.canary AND (n.last_paired_at IS NULL OR c.created_at >= n.last_paired_at)) AS calls_since_pairing,
        (SELECT count(*) FILTER (WHERE outcome LIKE 'waxum_closed:1005%')::int FROM (SELECT outcome FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id AND NOT c.canary ORDER BY c.created_at DESC LIMIT $3) l) AS last_1005,
        (SELECT count(*)::int FROM (SELECT 1 FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id AND NOT c.canary ORDER BY c.created_at DESC LIMIT $3) l) AS last_calls,
        EXISTS (SELECT 1 FROM audit_logs a WHERE a.tenant_id = n.tenant_id AND a.entity_id = n.id AND a.action = 'number.waxum_node_changed' AND a.created_at > now() - make_interval(mins => $4)) AS recently_moved
      FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.id = ANY($2::text[])
    `, [tenantId, ids, LAST_CALLS, RECENT_MOVE_MINUTES])).rows;
    const thresholds: Thresholds | undefined = (await this.latest(tenantId))?.sample?.thresholds;
    for (const fact of facts) {
      const label = live.find((line) => line.id === fact.id)?.label ?? fact.id;
      if (fact.recently_moved) alerts.push({ kind: 'recently_moved', numberId: fact.id, label, message: `${label} trocou de saída há menos de ${RECENT_MOVE_MINUTES} min.` });
      if (thresholds?.attentionCalls != null && thresholds.attentionConfidence !== 'insufficient_data' && fact.calls_since_pairing >= thresholds.attentionCalls) {
        alerts.push({ kind: 'near_fall_point', numberId: fact.id, label, message: `${label} já fez ${fact.calls_since_pairing} ligações desde o pareamento; um quarto das linhas caiu com até ${thresholds.attentionCalls}.` });
      }
      if (thresholds?.closed1005Rate != null && thresholds.closed1005Confidence !== 'insufficient_data' && fact.last_calls >= LAST_CALLS
        && (fact.last_1005 / fact.last_calls) * 100 >= thresholds.closed1005Rate) {
        alerts.push({ kind: 'many_1005', numberId: fact.id, label, message: `${label}: ${fact.last_1005} das últimas ${fact.last_calls} ligações caíram com erro 1005, como nas linhas antes de cair.` });
      }
    }
    return alerts;
  }
}
