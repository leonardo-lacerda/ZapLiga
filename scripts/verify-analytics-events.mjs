import pg from 'pg';

const baseUrl = process.env.ANALYTICS_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.ANALYTICS_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.ANALYTICS_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
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
      'outbound_webhook_deliveries', 'outbound_webhook_endpoints', 'analytics_event_receipts',
      'analytics_reconciliation_runs', 'analytics_event_outbox', 'analytics_events',
      'operation_health_snapshots', 'tenant_feature_flags', 'dialer_schedule_exceptions',
      'dialer_schedule_windows', 'contact_compliance_events', 'contact_suppressions',
      'metrics_daily_rollup', 'lead_stage_history', 'number_status_history',
      'sdr_availability_history', 'call_result_catalog', 'pipeline_stage_catalog',
      'lead_callbacks', 'call_decisions', 'decision_campaign_modes', 'decision_policies',
      'audit_logs', 'tenant_memberships', 'dialer_settings', 'campaign_playbooks',
      'campaign_event_outbox', 'lead_ingestion_outbox', 'lead_ingestion_events',
      'lead_integrations', 'campaigns', 'lead_folders', 'sdr_pauses', 'calls', 'leads',
      'sdrs', 'whatsapp_numbers',
    ]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } finally { await pool.end(); }
}

try {
  const login = await ok(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await ok(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Analytics ${suffix}`, slug: `analytics-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };

  const disabled = await request(`/api/tenants/${tenantId}/analytics/event-catalog`, { headers: auth });
  assert(disabled.response.status === 409, `analytics desligado deveria bloquear catálogo: ${disabled.response.status}`);
  await ok(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ analytics_learning: true, operation_health: true, schedule_enforcement: false }) }), 'habilita analytics');
  const catalog = await ok(await request(`/api/tenants/${tenantId}/analytics/event-catalog`, { headers: auth }), 'catálogo analítico');
  assert(catalog.formulaVersion === 1 && catalog.items.some((item) => item.eventType === 'health.changed'), 'catálogo deve ser versionado');

  const current = await ok(await request(`/api/tenants/${tenantId}/operation-health`, { headers: auth }), 'gera evento de saúde');
  assert(current.internalScoreNotice.includes('interno'), 'saúde deve continuar explicitamente interna');
  const events = await ok(await request(`/api/tenants/${tenantId}/analytics/events`, { headers: auth }), 'lista eventos');
  assert(events.items.some((item) => item.event_type === 'health.changed'), 'snapshot deve gerar evento analítico sanitizado');
  assert(!JSON.stringify(events).includes('admin@') && !JSON.stringify(events).includes('ZapCall-Smoke'), 'evento analítico não pode expor segredo');

  const reliability = await ok(await request(`/api/tenants/${tenantId}/analytics/reliability`, { headers: auth }), 'confiabilidade inicial');
  assert(reliability.status === 'insufficient_data', `período sem chamadas deveria ser insuficiente: ${reliability.status}`);
  const reconciliation = await ok(await request(`/api/tenants/${tenantId}/analytics/reconcile`, { method: 'POST', headers: auth }), 'reconciliação');
  assert(reconciliation.formulaVersion === 1 && reconciliation.score >= 0 && reconciliation.score <= 100, 'reconciliação deve retornar score limitado');
  const outbox = await ok(await request(`/api/tenants/${tenantId}/analytics/outbox`, { headers: auth }), 'saúde do outbox');
  assert(outbox.items && typeof outbox.items === 'object', 'outbox deve expor contagens por status');

  const webhook = await ok(await request(`/api/tenants/${tenantId}/outbound-webhooks`, { method: 'POST', headers: auth, body: JSON.stringify({ label: 'Analytics smoke', url: 'https://example.test/zapliga', eventTypes: ['health.changed'] }) }), 'cria webhook');
  assert(webhook.secret?.startsWith('zpl_wh_'), 'segredo do webhook deve ser exibido somente na criação');
  const webhooks = await ok(await request(`/api/tenants/${tenantId}/outbound-webhooks`, { headers: auth }), 'lista webhooks');
  assert(webhooks.items.length === 1 && !Object.prototype.hasOwnProperty.call(webhooks.items[0], 'secret'), 'listagem não pode devolver segredo');
  console.log(JSON.stringify({ ok: true, tenantId, events: events.items.length, reliability: reconciliation.status, webhookId: webhook.id }));
} finally {
  await cleanup();
}
