import pg from 'pg';

const baseUrl = process.env.OPERATION_HEALTH_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.OPERATION_HEALTH_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.OPERATION_HEALTH_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let tenantId = '';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};
const ok = async (result, label) => { assert(result.response.ok, `${label}: ${result.response.status} ${JSON.stringify(result.body)}`); return result.body; };

async function cleanup() {
  if (!tenantId) return;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  try {
    await pool.query("UPDATE tenants SET status = 'archived' WHERE id = $1", [tenantId]);
    for (const table of [
      'data_subject_exports', 'data_subject_request_events', 'data_subject_requests',
      'number_health_events', 'operation_health_snapshots', 'tenant_feature_flags',
      'dialer_schedule_exceptions', 'dialer_schedule_windows', 'contact_compliance_events',
      'contact_suppressions', 'number_status_history', 'sdr_availability_history',
      'call_result_catalog', 'pipeline_stage_catalog', 'lead_callbacks', 'call_decisions',
      'decision_campaign_modes', 'decision_policies', 'campaign_event_outbox', 'campaign_playbooks',
      'lead_ingestion_outbox', 'lead_ingestion_events', 'lead_integrations', 'tenant_notes',
      'invitations', 'audit_logs', 'tenant_memberships', 'websocket_tickets', 'dialer_settings',
      'campaigns', 'lead_folders', 'sdr_pauses', 'calls', 'leads', 'sdrs', 'whatsapp_numbers',
    ]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } finally { await pool.end(); }
}

try {
  const login = await ok(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await ok(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Operation Health ${suffix}`, slug: `operation-health-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };

  const disabled = await request(`/api/tenants/${tenantId}/operation-health`, { headers: auth });
  assert(disabled.response.status === 409, `flag desligada deveria bloquear saúde: ${disabled.response.status}`);
  await ok(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ operation_health: true, recommendations: true, schedule_enforcement: false }) }), 'habilita saúde');

  const current = await ok(await request(`/api/tenants/${tenantId}/operation-health`, { headers: auth }), 'score atual');
  assert(Number.isInteger(current.score) && current.score >= 0 && current.score <= 100, 'score deve estar entre 0 e 100');
  assert(current.formulaVersion === 'v1' && current.internalScoreNotice.includes('interno'), 'score deve declarar fórmula e natureza interna');
  assert(Array.isArray(current.components) && current.evidence && current.nextSafeAction, 'resposta deve explicar componentes, evidência e ação segura');
  assert(!JSON.stringify(current).includes('admin@') && !JSON.stringify(current).includes('ZapCall-Smoke'), 'saúde não pode expor segredo');
  const history = await ok(await request(`/api/tenants/${tenantId}/operation-health/history`, { headers: auth }), 'histórico de saúde');
  assert(history.items.length >= 1 && history.items[0].formulaVersion === 'v1', 'snapshot deve sobreviver no histórico');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  const numberId = `health-number-${suffix}`;
  try {
    await pool.query(`INSERT INTO whatsapp_numbers (id, tenant_id, label, waxum_session_id, status) VALUES ($1, $2, 'Linha Health', $3, 'connected')`, [numberId, tenantId, `health-session-${suffix}`]);
    await pool.query(`INSERT INTO number_status_history (tenant_id, number_id, from_status, to_status) VALUES ($1, $2, 'disconnected', 'connected')`, [tenantId, numberId]);
  } finally { await pool.end(); }
  const number = await ok(await request(`/api/tenants/${tenantId}/numbers/${numberId}/health`, { headers: auth }), 'saúde da linha');
  assert(number.numberId === numberId && number.formulaVersion === 'v1', 'saúde da linha deve ser tenant-scoped');
  await ok(await request(`/api/tenants/${tenantId}/operation-health`, { headers: auth }), 'atualiza risco da operação');
  const checkPool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  try {
    const risk = await checkPool.query(`SELECT code, evidence FROM operation_recommendations WHERE tenant_id = $1 AND code LIKE 'operation_health_%' AND status IN ('active','snoozed')`, [tenantId]);
    assert(risk.rows.some((row) => row.evidence?.source === 'operation_health'), 'saúde deve alimentar recomendações com evidência agregada');
  } finally { await checkPool.end(); }
  const events = await ok(await request(`/api/tenants/${tenantId}/numbers/${numberId}/health/events`, { headers: auth }), 'eventos da linha');
  assert(events.items.some((event) => event.eventType === 'reconnected' && event.actorType === 'automatic'), 'timeline deve normalizar histórico automático');
  console.log(JSON.stringify({ ok: true, tenantId, state: current.state, score: current.score, events: events.items.length }));
} finally {
  await cleanup();
}
