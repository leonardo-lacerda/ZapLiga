import pg from 'pg';

const baseUrl = process.env.RECOMMENDATIONS_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.RECOMMENDATIONS_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.RECOMMENDATIONS_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
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
      'recommendation_events', 'operation_recommendations', 'number_health_events', 'operation_health_snapshots', 'tenant_onboarding_steps', 'tenant_feature_flags',
      'dialer_schedule_exceptions', 'dialer_schedule_windows', 'contact_compliance_events', 'contact_suppressions',
      'metric_exports', 'metric_saved_views', 'metric_goals', 'metrics_daily_rollup', 'lead_stage_history',
      'number_status_history', 'sdr_availability_history', 'tenant_notes', 'call_result_catalog', 'pipeline_stage_catalog',
      'lead_callbacks', 'call_decisions', 'decision_campaign_modes', 'decision_policies', 'calls', 'sdr_pauses', 'leads',
      'campaign_event_outbox', 'campaign_playbooks', 'lead_ingestion_outbox', 'lead_ingestion_events', 'lead_integrations',
      'tenant_memberships', 'websocket_tickets', 'dialer_settings', 'campaigns', 'lead_folders', 'sdrs', 'whatsapp_numbers', 'audit_logs',
    ]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } finally { await pool.end(); }
}

try {
  const login = await ok(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await ok(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Recommendations ${suffix}`, slug: `recommendations-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
  const disabled = await request(`/api/tenants/${tenantId}/recommendations`, { headers: auth });
  assert(disabled.response.status === 409, `flag desligada deveria bloquear recomendações: ${disabled.response.status}`);
  await ok(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ recommendations: true, schedule_enforcement: false }) }), 'habilita recomendações');

  const list = await ok(await request(`/api/tenants/${tenantId}/recommendations`, { headers: auth }), 'lista recomendações');
  assert(Array.isArray(list.items) && list.items.length <= 3, 'central deve limitar a três itens');
  if (list.items[0]) {
    const item = list.items[0];
    assert(item.evidence && item.evidence.source === 'metrics_summary', 'evidência precisa declarar a fonte');
    assert(!JSON.stringify(item).includes('admin@') && !JSON.stringify(item).includes('ZapCall-Smoke'), 'recomendação não pode expor segredo');
    await ok(await request(`/api/tenants/${tenantId}/recommendations/${item.id}/events`, { method: 'POST', headers: auth, body: JSON.stringify({ eventType: 'opened' }) }), 'registra abertura');
    await ok(await request(`/api/tenants/${tenantId}/recommendations/${item.id}/snooze`, { method: 'POST', headers: auth }), 'adiamento');
    const history = await ok(await request(`/api/tenants/${tenantId}/recommendations/history?recommendationId=${encodeURIComponent(item.id)}`, { headers: auth }), 'histórico');
    assert(history.items.some((event) => event.event_type === 'opened') && history.items.some((event) => event.event_type === 'snoozed'), 'interações devem ser auditáveis');
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  try {
    await pool.query("UPDATE dialer_settings SET running=false WHERE tenant_id=$1", [tenantId]);
    await pool.query(`INSERT INTO operation_recommendations (id, tenant_id, code, scope_key, status, severity, title_key, evidence, recommended_action, action_type, action_payload, fingerprint)
      VALUES ('manual-start-action',$1,'dialer_paused_with_queue','manual','active','warning','Iniciar discador',$2::jsonb,$3::jsonb,'start_dialer','{}'::jsonb,'manual-start-action-v1')`, [tenantId, JSON.stringify({ summary: 'fixture', source: 'metrics_summary', observedAt: new Date().toISOString() }), JSON.stringify({ label: 'Iniciar discador', type: 'start_dialer', payload: {} })]);
  } finally { await pool.end(); }
  const applied = await ok(await request(`/api/tenants/${tenantId}/recommendations/manual-start-action/apply`, { method: 'POST', headers: auth }), 'aplica ação catalogada');
  assert(applied.result?.kind === 'dialer_started', `ação operacional não foi aplicada: ${JSON.stringify(applied)}`);
  const repeated = await request(`/api/tenants/${tenantId}/recommendations/manual-start-action/apply`, { method: 'POST', headers: auth });
  assert(repeated.response.status === 409, `ação resolvida deveria bloquear repetição: ${repeated.response.status}`);
  console.log(JSON.stringify({ ok: true, tenantId, items: list.items.length }));
} finally {
  await cleanup();
}
