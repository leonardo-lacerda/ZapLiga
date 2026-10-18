/**
 * Shapes shared by the CRM integration API responses and the webhook events, so the CRM sees the
 * same call and line objects whether it asks or is told.
 */
const futureIso = (value: unknown) => value && new Date(String(value)).getTime() > Date.now() ? new Date(String(value)).toISOString() : null;

// A line as the CRM sees it: the number row plus its live calls and how it was used in the last day,
// so the CRM can suggest the line least at risk and show when each one last called. A failure because
// the lead has no WhatsApp says nothing about the line, so it is not counted against it.
export const LINE_SELECT = `SELECT n.*,
  (SELECT count(*)::int FROM calls c WHERE c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')) AS active_calls,
  (SELECT max(c.created_at) FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id) AS last_call_at,
  (SELECT count(*)::int FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id AND c.created_at > now() - interval '24 hours') AS calls_24h,
  (SELECT count(*)::int FROM calls c WHERE c.tenant_id = n.tenant_id AND c.number_id = n.id AND c.created_at > now() - interval '24 hours'
     AND c.status = 'failed' AND coalesce(c.failure_reason, '') NOT LIKE 'sem_whatsapp%') AS failed_calls_24h
  FROM whatsapp_numbers n`;

export const lineView = (row: any) => {
  const quarantinedUntil = futureIso(row.flagged_until);
  return {
    id: row.id, label: row.label, phone: row.phone ?? null, status: row.status,
    in_call: Number(row.active_calls ?? 0) > 0,
    available_at: quarantinedUntil ?? futureIso(row.last_call_ended_at),
    quarantined_until: quarantinedUntil,
    protection: { cooldown_seconds: row.cooldown_seconds, max_calls_per_window: row.max_calls_per_window, call_window_seconds: row.call_window_seconds, max_concurrent_calls: row.max_concurrent_calls },
    // Only rows read through LINE_SELECT know their usage; the others leave it out rather than report zeros
    ...('calls_24h' in row ? { usage: {
      last_call_at: row.last_call_at ? new Date(String(row.last_call_at)).toISOString() : null,
      calls_24h: Number(row.calls_24h ?? 0),
      failed_calls_24h: Number(row.failed_calls_24h ?? 0),
    } } : {}),
    created_at: row.created_at,
  };
};

export const CALL_SELECT = `SELECT c.*, l.phone AS lead_phone, l.name AS lead_name,
    n.label AS number_label, n.phone AS number_phone, n.flagged_until AS number_flagged_until, n.last_call_ended_at AS number_last_call_ended_at,
    s.name AS sdr_name, a.external_user_id
  FROM calls c
  JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
  JOIN whatsapp_numbers n ON n.id = c.number_id
  JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id
  LEFT JOIN crm_integration_agents a ON a.integration_id = c.integration_id AND a.sdr_id = c.sdr_id`;

export const callView = (row: any) => {
  const quarantinedUntil = futureIso(row.number_flagged_until);
  return {
    id: row.id, status: row.status, source: row.source, outcome: row.outcome ?? null, failure_reason: row.failure_reason ?? null,
    call_result: row.call_result ?? null, pipeline_stage: row.pipeline_stage ?? null, notes: row.notes ?? null,
    to_phone: row.lead_phone ?? null, lead_name: row.lead_name ?? null, lead_id: row.lead_id,
    number: { id: row.number_id, label: row.number_label ?? null, phone: row.number_phone ?? null, available_at: quarantinedUntil ?? futureIso(row.number_last_call_ended_at), quarantined_until: quarantinedUntil },
    sdr: { id: row.sdr_id, name: row.sdr_name ?? null, external_user_id: row.external_user_id ?? null },
    external_ref: row.external_ref ?? null,
    created_at: row.created_at, started_at: row.started_at ?? null, connected_at: row.connected_at ?? null, ended_at: row.ended_at ?? null,
    duration_seconds: row.duration_seconds ?? null, ring_duration_seconds: row.ring_duration_seconds ?? null, connected_duration_seconds: row.connected_duration_seconds ?? null,
    wrap_up_completed_at: row.wrap_up_completed_at ?? null,
  };
};
