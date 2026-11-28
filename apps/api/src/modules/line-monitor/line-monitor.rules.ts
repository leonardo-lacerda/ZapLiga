/**
 * Line monitor rules (docs/line-monitor.md): what counts as a lost line, a short call, a failed
 * Waxum call, and the SQL that rebuilds one line-day of `line_daily_stats` (migration 085).
 */
import { YOUNG_LINE_DAYS } from '../dialer/dialer.rules';

/** Causes that take a line out: the ones the learnings count as "the line fell". */
export const LINE_FELL_CAUSES = ['device_removed', 'account_locked', 'temp_banned'] as const;
/** An answered call shorter than this counts as short (the lead hung up at once). */
export const SHORT_ANSWERED_SECONDS = 10;
/** Line statuses that hold a live WhatsApp session (same list as NumbersService.list). */
export const CONNECTED_STATUSES = ['connected', 'online', 'ready', 'authenticated'] as const;
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
/** The longest period one request may read. */
export const MAX_PERIOD_DAYS = 366;

/**
 * Upserts the day $2 (a civil date in timezone $3) of every line of tenant $1. $4 marks the setup
 * columns as copied from the line's current state (days rebuilt after the fact). Canary calls go
 * to a team phone, so they stay out of the call counts.
 */
export const UPSERT_LINE_DAY_SQL = `
  WITH bounds AS (SELECT ($2::date)::timestamp AT TIME ZONE $3 AS s, ($2::date + 1)::timestamp AT TIME ZONE $3 AS e)
  INSERT INTO line_daily_stats (tenant_id, number_id, day, label, waxum_node, status, canary_status, age_days, young, stealth, device_profile, business,
    config_estimated, calls, answered, talk_seconds, short_answered, closed_1005, waxum_failures, no_whatsapp, losses, lost, loss_cause, reconnects,
    node_moves, network_bytes, first_call_at, last_call_at, updated_at)
  SELECT n.tenant_id, n.id, $2::date, n.label, n.waxum_node, n.status, n.canary_status,
    CASE WHEN n.last_paired_at IS NULL THEN NULL ELSE GREATEST(0, $2::date - (n.last_paired_at AT TIME ZONE $3)::date) END,
    COALESCE(n.last_paired_at > b.e - make_interval(days => ${YOUNG_LINE_DAYS}), false),
    COALESCE(n.stealth_enabled, false), COALESCE(n.device_profile_active, false), COALESCE((n.device_profile->'android'->>'business')::boolean, false),
    $4::boolean, c.calls, c.answered, c.talk_seconds, c.short_answered, c.closed_1005, c.waxum_failures, c.no_whatsapp,
    COALESCE(l.losses, '{}'::jsonb), COALESCE(l.lost, false), l.loss_cause, r.reconnects, m.node_moves, COALESCE(u.network_bytes, 0),
    c.first_call_at, c.last_call_at, now()
  FROM whatsapp_numbers n CROSS JOIN bounds b
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS calls, count(connected_at)::int AS answered,
      COALESCE(sum(connected_duration_seconds) FILTER (WHERE connected_at IS NOT NULL), 0)::int AS talk_seconds,
      count(*) FILTER (WHERE connected_at IS NOT NULL AND COALESCE(connected_duration_seconds, 0) < ${SHORT_ANSWERED_SECONDS})::int AS short_answered,
      count(*) FILTER (WHERE outcome LIKE 'waxum_closed:1005%')::int AS closed_1005,
      count(*) FILTER (WHERE outcome LIKE 'waxum\\_%' AND outcome NOT LIKE 'waxum_closed:1005%')::int AS waxum_failures,
      count(*) FILTER (WHERE outcome LIKE 'sem_whatsapp%')::int AS no_whatsapp,
      min(created_at) AS first_call_at, max(created_at) AS last_call_at
    FROM calls WHERE tenant_id = n.tenant_id AND number_id = n.id AND created_at >= b.s AND created_at < b.e AND NOT canary
  ) c
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(x.cause, x.total) AS losses, bool_or(x.fell) AS lost,
      (array_agg(x.cause ORDER BY x.last_at DESC) FILTER (WHERE x.fell))[1] AS loss_cause
    FROM (SELECT cause, count(*)::int AS total, max(occurred_at) AS last_at, cause = ANY($5::text[]) AS fell
      FROM line_loss_events WHERE tenant_id = n.tenant_id AND number_id = n.id AND occurred_at >= b.s AND occurred_at < b.e GROUP BY cause) x
  ) l ON true
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS reconnects FROM number_status_history h
    WHERE h.tenant_id = n.tenant_id AND h.number_id = n.id AND h.changed_at >= b.s AND h.changed_at < b.e AND lower(h.to_status) = ANY($6::text[])
  ) r
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS node_moves FROM audit_logs a
    WHERE a.tenant_id = n.tenant_id AND a.entity_id = n.id AND a.action = 'number.waxum_node_changed' AND a.created_at >= b.s AND a.created_at < b.e
  ) m
  LEFT JOIN LATERAL (SELECT sum(rx_bytes + tx_bytes)::bigint AS network_bytes FROM egress_proxy_usage WHERE number_id = n.id AND day = $2::date) u ON true
  WHERE n.tenant_id = $1 AND n.created_at < b.e
    AND (n.status <> 'removed' OR c.calls > 0 OR l.losses IS NOT NULL)
  ON CONFLICT (tenant_id, number_id, day) DO UPDATE SET
    label = EXCLUDED.label, waxum_node = EXCLUDED.waxum_node, status = EXCLUDED.status, canary_status = EXCLUDED.canary_status,
    age_days = EXCLUDED.age_days, young = EXCLUDED.young, stealth = EXCLUDED.stealth, device_profile = EXCLUDED.device_profile,
    business = EXCLUDED.business, config_estimated = EXCLUDED.config_estimated, calls = EXCLUDED.calls, answered = EXCLUDED.answered,
    talk_seconds = EXCLUDED.talk_seconds, short_answered = EXCLUDED.short_answered, closed_1005 = EXCLUDED.closed_1005,
    waxum_failures = EXCLUDED.waxum_failures, no_whatsapp = EXCLUDED.no_whatsapp, losses = EXCLUDED.losses, lost = EXCLUDED.lost,
    loss_cause = EXCLUDED.loss_cause, reconnects = EXCLUDED.reconnects, node_moves = EXCLUDED.node_moves,
    network_bytes = EXCLUDED.network_bytes, first_call_at = EXCLUDED.first_call_at, last_call_at = EXCLUDED.last_call_at, updated_at = now()
`;

export const upsertLineDayParams = (tenantId: string, day: string, timezone: string, estimated: boolean) =>
  [tenantId, day, timezone, estimated, [...LINE_FELL_CAUSES], [...CONNECTED_STATUSES]];

/** The civil date (YYYY-MM-DD) and hour of `at` in `timezone`. */
export function localDay(at: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** `day` (YYYY-MM-DD) moved by `delta` days. */
export function shiftDay(day: string, delta: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}
