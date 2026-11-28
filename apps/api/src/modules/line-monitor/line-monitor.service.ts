import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { REPORT_STALE_SECONDS } from '../egress/pc-network';
import { buildCsv, CsvColumn } from '../metrics/metrics-csv';
import { NumbersService } from '../numbers/numbers.service';
import { LineDailyStatsService } from './line-daily-stats.service';
import { LineLearningsService } from './line-learnings.service';
import { DEFAULT_TIMEZONE, LINE_FELL_CAUSES, MAX_PERIOD_DAYS, SHORT_ANSWERED_SECONDS, daysBetween, localDay } from './line-monitor.rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIMELINE_LIMIT = 500;
const NOTE_MAX = 1000;
/** Health events the timeline shows; the losses come from line_loss_events, with their context. */
const TIMELINE_HEALTH_EVENTS = ['canary_passed', 'canary_failed', 'quarantine_started', 'manual_protection', 'registration_reason'];
export const EXPORT_DATASETS = ['lines', 'daily', 'losses', 'timeline'] as const;
export type ExportDataset = typeof EXPORT_DATASETS[number];

export type Period = { from: string; to: string; timezone: string };

/**
 * Reads behind the "Monitor de linhas" tab (docs/line-monitor.md): the lines and PCs now, a
 * period's numbers by line, attendant and hour, the timeline of what happened to the lines, the
 * daily history, CSV exports and the team's notes.
 */
@Injectable()
export class LineMonitorService {
  constructor(
    private readonly db: DatabaseService,
    private readonly numbers: NumbersService,
    private readonly daily: LineDailyStatsService,
    private readonly learnings: LineLearningsService,
  ) {}

  async timezone(tenantId: string) {
    return (await this.db.query<{ timezone: string }>('SELECT COALESCE(timezone, $2) AS timezone FROM tenants WHERE id = $1', [tenantId, DEFAULT_TIMEZONE])).rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }

  /** `from`/`to` are civil dates (YYYY-MM-DD) in the tenant's timezone; both default to today. */
  async period(tenantId: string, from?: string, to?: string): Promise<Period> {
    const timezone = await this.timezone(tenantId);
    const today = localDay(new Date(), timezone).day;
    const start = from ?? to ?? today;
    const end = to ?? from ?? today;
    if (!DAY.test(start) || !DAY.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new BadRequestException('Datas inválidas: use AAAA-MM-DD');
    if (start > end) throw new BadRequestException('A data inicial vem depois da final');
    if (daysBetween(start, end).length > MAX_PERIOD_DAYS) throw new BadRequestException(`O período máximo é de ${MAX_PERIOD_DAYS} dias`);
    return { from: start, to: end, timezone };
  }

  async now(tenantId: string) {
    const lines = (await this.numbers.list(tenantId, 200, 0)).items;
    const exits = (await this.db.query(`
      SELECT p.id, p.name, p.slot, 'pc' AS kind, p.offline_since, p.online_since, p.route_reported_at,
        COALESCE(p.route = 'pc' AND p.route_reported_at > now() - make_interval(secs => $2), false) AS online,
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.waxum_node = p.slot AND n.status <> 'removed') AS lines
      FROM egress_pcs p WHERE p.slot IS NOT NULL
      UNION ALL
      SELECT x.id, x.name, x.slot, 'proxy', NULL, NULL, x.route_reported_at,
        COALESCE(x.route = 'proxy' AND x.route_reported_at > now() - make_interval(secs => $2), false),
        (SELECT count(*)::int FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.waxum_node = x.slot AND n.status <> 'removed')
      FROM egress_proxies x
      ORDER BY kind, slot
    `, [tenantId, REPORT_STALE_SECONDS])).rows;
    const alerts = await this.learnings.alerts(tenantId, lines, exits);
    return { at: new Date().toISOString(), lines, exits, alerts };
  }

  /** A period's numbers. Today's rows are rebuilt first, so the period always includes the last call. */
  async periodReport(tenantId: string, period: Period) {
    const today = localDay(new Date(), period.timezone).day;
    if (period.to >= today) await this.daily.upsertDay(tenantId, today, period.timezone);
    const lines = (await this.db.query(`
      SELECT number_id, max(label) AS label, sum(calls)::int AS calls, sum(answered)::int AS answered, sum(talk_seconds)::int AS talk_seconds,
        sum(short_answered)::int AS short_answered, sum(closed_1005)::int AS closed_1005, sum(waxum_failures)::int AS waxum_failures,
        sum(no_whatsapp)::int AS no_whatsapp, sum(reconnects)::int AS reconnects, sum(node_moves)::int AS node_moves,
        sum(network_bytes)::bigint AS network_bytes, bool_or(lost) AS lost,
        (array_agg(loss_cause ORDER BY day DESC) FILTER (WHERE loss_cause IS NOT NULL))[1] AS loss_cause,
        (SELECT jsonb_object_agg(k, v) FROM (SELECT key AS k, sum(value::int)::int AS v FROM line_daily_stats d2, jsonb_each_text(d2.losses)
          WHERE d2.tenant_id = $1 AND d2.number_id = d.number_id AND d2.day BETWEEN $2::date AND $3::date GROUP BY key) t) AS losses,
        (array_agg(waxum_node ORDER BY day DESC))[1] AS waxum_node, min(first_call_at) AS first_call_at, max(last_call_at) AS last_call_at
      FROM line_daily_stats d WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date
      GROUP BY number_id HAVING sum(calls) > 0 OR bool_or(losses <> '{}'::jsonb)
      ORDER BY sum(calls) DESC, max(label)
    `, [tenantId, period.from, period.to])).rows;
    const callStats = `count(*)::int AS calls, count(c.connected_at)::int AS answered,
      COALESCE(sum(c.connected_duration_seconds) FILTER (WHERE c.connected_at IS NOT NULL), 0)::int AS talk_seconds,
      count(*) FILTER (WHERE c.outcome LIKE 'waxum_closed:1005%')::int AS closed_1005`;
    const calls = `calls c WHERE c.tenant_id = $1 AND NOT c.canary
      AND c.created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND c.created_at < ($3::date + 1)::timestamp AT TIME ZONE $4`;
    const callParams = [tenantId, period.from, period.to, period.timezone];
    const sdrs = (await this.db.query(`
      SELECT c.sdr_id, COALESCE((SELECT s.name FROM sdrs s WHERE s.id = c.sdr_id), 'Sem atendente') AS name, ${callStats}
      FROM ${calls} GROUP BY c.sdr_id ORDER BY count(*) DESC
    `, callParams)).rows;
    const hours = (await this.db.query(`
      SELECT extract(hour FROM c.created_at AT TIME ZONE $4)::int AS hour, ${callStats}
      FROM ${calls} GROUP BY 1 ORDER BY 1
    `, callParams)).rows;
    const sum = (key: string) => lines.reduce((total, line) => total + Number(line[key] ?? 0), 0);
    const totals = {
      calls: sum('calls'), answered: sum('answered'), talk_seconds: sum('talk_seconds'), short_answered: sum('short_answered'),
      closed_1005: sum('closed_1005'), waxum_failures: sum('waxum_failures'), no_whatsapp: sum('no_whatsapp'),
      active_lines: lines.filter((line) => Number(line.calls) > 0).length, lost_lines: lines.filter((line) => line.lost).length,
    };
    return { period, totals, lines, sdrs, hours, shortAnsweredSeconds: SHORT_ANSWERED_SECONDS };
  }

  async timeline(tenantId: string, period: Period, numberId?: string) {
    const params = [tenantId, period.from, period.to, period.timezone, numberId ?? null, TIMELINE_HEALTH_EVENTS, TIMELINE_LIMIT];
    const range = (column: string) => `${column} >= ($2::date)::timestamp AT TIME ZONE $4 AND ${column} < ($3::date + 1)::timestamp AT TIME ZONE $4`;
    const items = (await this.db.query(`
      SELECT * FROM (
        SELECT 'loss' AS kind, e.id, e.number_id, n.label, e.cause AS code, e.occurred_at AS at, e.detail AS detail
        FROM line_loss_events e LEFT JOIN whatsapp_numbers n ON n.id = e.number_id
        WHERE e.tenant_id = $1 AND ($5::text IS NULL OR e.number_id = $5) AND ${range('e.occurred_at')}
        UNION ALL
        SELECT 'health', h.id, h.number_id, n.label, h.event_type, h.occurred_at, h.metadata
        FROM number_health_events h LEFT JOIN whatsapp_numbers n ON n.id = h.number_id
        WHERE h.tenant_id = $1 AND h.event_type = ANY($6::text[]) AND ($5::text IS NULL OR h.number_id = $5) AND ${range('h.occurred_at')}
        UNION ALL
        SELECT 'move', a.id, a.entity_id, n.label, 'waxum_node_changed', a.created_at, a.metadata || jsonb_build_object('automatic', a.actor_user_id IS NULL)
        FROM audit_logs a LEFT JOIN whatsapp_numbers n ON n.id = a.entity_id
        WHERE a.tenant_id = $1 AND a.action = 'number.waxum_node_changed' AND ($5::text IS NULL OR a.entity_id = $5) AND ${range('a.created_at')}
        UNION ALL
        SELECT 'pc', p.id, NULL, p.pc_name, p.kind, p.occurred_at, p.detail || jsonb_build_object('slot', p.slot)
        FROM egress_pc_events p
        WHERE $5::text IS NULL AND ${range('p.occurred_at')}
          -- PCs that hold this tenant's lines now, or held them when the PC changed (moves away from it are audited).
          AND (EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.waxum_node = p.slot)
            OR EXISTS (SELECT 1 FROM audit_logs a WHERE a.tenant_id = $1 AND a.action = 'number.waxum_node_changed'
              AND a.metadata->>'from' = p.slot AND a.created_at >= p.occurred_at - interval '1 day'))
        UNION ALL
        SELECT 'note', o.id, o.number_id, n.label, 'note', o.occurred_at, jsonb_build_object('body', o.body, 'authorUserId', o.author_user_id, 'author', u.name)
        FROM line_notes o LEFT JOIN whatsapp_numbers n ON n.id = o.number_id LEFT JOIN users u ON u.id = o.author_user_id
        WHERE o.tenant_id = $1 AND ($5::text IS NULL OR o.number_id = $5 OR o.number_id IS NULL) AND ${range('o.occurred_at')}
      ) t ORDER BY at DESC LIMIT $7
    `, params)).rows;
    return { period, items, limit: TIMELINE_LIMIT };
  }

  async history(tenantId: string, period: Period) {
    const today = localDay(new Date(), period.timezone).day;
    if (period.to >= today) await this.daily.upsertDay(tenantId, today, period.timezone);
    const days = (await this.db.query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(calls)::int AS calls, sum(answered)::int AS answered, sum(talk_seconds)::int AS talk_seconds,
        sum(closed_1005)::int AS closed_1005, count(*) FILTER (WHERE calls > 0)::int AS active_lines, count(*) FILTER (WHERE lost)::int AS lost_lines,
        bool_or(config_estimated) AS config_estimated
      FROM line_daily_stats WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date GROUP BY day ORDER BY day
    `, [tenantId, period.from, period.to])).rows;
    const notes = (await this.db.query(`
      SELECT id, number_id, body, occurred_at FROM line_notes
      WHERE tenant_id = $1 AND occurred_at >= ($2::date)::timestamp AT TIME ZONE $4 AND occurred_at < ($3::date + 1)::timestamp AT TIME ZONE $4
      ORDER BY occurred_at
    `, [tenantId, period.from, period.to, period.timezone])).rows;
    return { period, days, notes };
  }

  async exportCsv(tenantId: string, dataset: ExportDataset, period: Period) {
    const fileName = `monitor-linhas-${dataset}-${period.from}_${period.to}.csv`;
    if (dataset === 'lines') {
      const report = await this.periodReport(tenantId, period);
      const columns: CsvColumn[] = [
        { key: 'label', label: 'Linha' }, { key: 'waxum_node', label: 'Saída' }, { key: 'calls', label: 'Ligações' }, { key: 'answered', label: 'Atendidas' },
        { key: 'talk_seconds', label: 'Conversa (s)' }, { key: 'short_answered', label: `Atendidas < ${SHORT_ANSWERED_SECONDS}s` },
        { key: 'closed_1005', label: 'Caíram 1005' }, { key: 'waxum_failures', label: 'Falhas do Waxum' }, { key: 'no_whatsapp', label: 'Sem WhatsApp' },
        { key: 'reconnects', label: 'Reconexões' }, { key: 'node_moves', label: 'Trocas de PC' }, { key: 'loss_cause', label: 'Queda' }, { key: 'losses_text', label: 'Quedas por causa' },
      ];
      return { fileName, content: buildCsv(columns, report.lines.map((line) => ({ ...line, losses_text: losesText(line.losses) }))) };
    }
    if (dataset === 'daily') {
      const rows = (await this.db.query(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day_text FROM line_daily_stats WHERE tenant_id = $1 AND day BETWEEN $2::date AND $3::date ORDER BY day, label`, [tenantId, period.from, period.to])).rows;
      const keys = ['label', 'waxum_node', 'status', 'canary_status', 'age_days', 'young', 'stealth', 'device_profile', 'business', 'config_estimated', 'calls', 'answered',
        'talk_seconds', 'short_answered', 'closed_1005', 'waxum_failures', 'no_whatsapp', 'lost', 'loss_cause', 'reconnects', 'node_moves', 'network_bytes'];
      return { fileName, content: buildCsv([{ key: 'day_text', label: 'day' }, ...keys.map((key) => ({ key, label: key })), { key: 'losses_text', label: 'losses' }], rows.map((row) => ({ ...row, losses_text: losesText(row.losses) }))) };
    }
    if (dataset === 'losses') {
      const rows = (await this.db.query(`
        SELECT e.occurred_at, n.label, e.cause, e.code, e.violation_type, e.violation_reason, e.detail->'context' AS context
        FROM line_loss_events e LEFT JOIN whatsapp_numbers n ON n.id = e.number_id
        WHERE e.tenant_id = $1 AND e.cause = ANY($5::text[])
          AND e.occurred_at >= ($2::date)::timestamp AT TIME ZONE $4 AND e.occurred_at < ($3::date + 1)::timestamp AT TIME ZONE $4
        ORDER BY e.occurred_at
      `, [tenantId, period.from, period.to, period.timezone, [...LINE_FELL_CAUSES, 'reachout_timelock', 'logged_out_other']])).rows;
      const contextKeys = ['waxumNode', 'ageHours', 'callsToday', 'callsSincePairing', 'reconnects24h', 'nodeMoves24h', 'stealth', 'deviceProfile', 'business', 'canaryStatus', 'canaryManual'];
      const flat = rows.map((row) => ({ ...row, occurred_at: new Date(row.occurred_at).toISOString(), ...Object.fromEntries(contextKeys.map((key) => [key, row.context?.[key] ?? ''])) }));
      return { fileName, content: buildCsv([{ key: 'occurred_at', label: 'Quando (UTC)' }, { key: 'label', label: 'Linha' }, { key: 'cause', label: 'Causa' }, { key: 'code', label: 'Código' },
        { key: 'violation_type', label: 'Violação' }, { key: 'violation_reason', label: 'Motivo' }, ...contextKeys.map((key) => ({ key, label: key }))], flat) };
    }
    const { items } = await this.timeline(tenantId, period);
    return { fileName, content: buildCsv([{ key: 'at', label: 'Quando (UTC)' }, { key: 'kind', label: 'Tipo' }, { key: 'label', label: 'Linha ou PC' }, { key: 'code', label: 'Evento' }, { key: 'detail_text', label: 'Detalhe' }],
      items.map((item) => ({ ...item, at: new Date(item.at).toISOString(), detail_text: JSON.stringify(item.detail ?? {}) }))) };
  }

  async addNote(tenantId: string, authorUserId: string, input: { body: string; numberId?: string | null; occurredAt?: string | null }) {
    const body = input.body.trim();
    if (!body || body.length > NOTE_MAX) throw new BadRequestException(`A nota precisa ter de 1 a ${NOTE_MAX} caracteres`);
    if (input.numberId && !(await this.db.query('SELECT 1 FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2', [input.numberId, tenantId])).rows[0]) throw new NotFoundException('Número não encontrado');
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException('Data da nota inválida');
    return (await this.db.query(`
      INSERT INTO line_notes (tenant_id, number_id, author_user_id, body, occurred_at) VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [tenantId, input.numberId ?? null, authorUserId, body, occurredAt])).rows[0];
  }

  async removeNote(tenantId: string, id: string) {
    const removed = await this.db.query('DELETE FROM line_notes WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
    if (!removed.rows[0]) throw new NotFoundException('Nota não encontrada');
    return { ok: true };
  }
}

function losesText(losses: Record<string, number> | null | undefined) {
  return Object.entries(losses ?? {}).map(([cause, total]) => `${cause}:${total}`).join(' ');
}
