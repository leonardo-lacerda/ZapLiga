import pg from 'pg';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.CAMPAIGN_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.CAMPAIGN_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.CAMPAIGN_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let tenantId = '';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};
const expectOk = async (result, label) => {
  assert(result.response.ok, `${label}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
};
const headers = (token) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': tenantId });

async function cleanup() {
  if (!tenantId) return;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  try {
    await pool.query("UPDATE tenants SET status = 'archived' WHERE id = $1", [tenantId]);
    for (const table of [
      'data_subject_exports', 'data_subject_request_events', 'data_subject_requests', 'tenant_onboarding_steps', 'tenant_feature_flags',
      'dialer_schedule_exceptions', 'dialer_schedule_windows', 'contact_compliance_events', 'contact_suppressions',
      'metric_exports', 'metric_saved_views', 'metric_goals', 'metrics_daily_rollup', 'lead_stage_history',
      'number_status_history', 'sdr_availability_history', 'tenant_notes', 'call_result_catalog', 'pipeline_stage_catalog',
      'lead_callbacks', 'campaigns', 'lead_folders', 'calls', 'sdr_pauses', 'leads', 'audit_logs', 'invitations',
      'tenant_memberships', 'websocket_tickets', 'dialer_settings', 'sdrs', 'whatsapp_numbers',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } finally { await pool.end(); }
}

try {
  const login = await expectOk(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await expectOk(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Campaign lifecycle ${suffix}`, slug: `campaign-lifecycle-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = headers(token);
  await expectOk(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ campaigns: true }) }), 'habilita campaigns');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  const folderId = randomUUID();
  const sdrId = randomUUID();
  const numberId = randomUUID();
  await pool.query('INSERT INTO lead_folders (id, tenant_id, name, is_active) VALUES ($1, $2, $3, true)', [folderId, tenantId, 'Lifecycle folder']);
  await pool.query('INSERT INTO sdrs (id, tenant_id, name) VALUES ($1, $2, $3)', [sdrId, tenantId, 'Lifecycle SDR']);
  await pool.query("INSERT INTO whatsapp_numbers (id, tenant_id, label, phone, waxum_session_id, status) VALUES ($1, $2, $3, $4, $5, 'waiting_for_qr')", [numberId, tenantId, 'Lifecycle line', '5511999990000', `lifecycle-session-${suffix}`]);
  await pool.end();

  const config = { queueStrategy: 'priority_fifo', maxAttemptsPerLead: 3, retryDelayMinutes: 60, maxCallsPerMinute: 20, minSecondsBetweenCalls: 10, timezone: 'America/Sao_Paulo', scheduleWindows: [] };
  const created = await expectOk(await request(`/api/tenants/${tenantId}/campaigns`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `Lifecycle ${suffix}`, description: 'E2E lifecycle', folderId, primaryGoalMetric: 'qualified_leads', primaryGoalTarget: 10, sdrIds: [sdrId], numberIds: [numberId], config }) }), 'cria campanha');
  assert(created.status === 'draft' && created.current_version === null && created.lock_version === 0, 'rascunho inicial inconsistente');
  const campaignId = created.id;
  const published = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: 0, reason: 'Primeira publicação' }) }), 'publica v1');
  assert(published.status === 'ready' && published.current_version === 1 && published.lock_version === 1, 'publicação v1 inconsistente');
  const stale = await request(`/api/tenants/${tenantId}/campaigns/${campaignId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ expectedLockVersion: 0, description: 'stale', config }) });
  assert(stale.response.status === 409, 'lock otimista aceitou edição atrasada');
  const running = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/start`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: 1 }) }), 'inicia campanha');
  assert(running.status === 'running' && running.lock_version === 2, 'início inconsistente');
  const edited = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ expectedLockVersion: 2, changeReason: 'Ajuste de ritmo', config: { ...config, maxCallsPerMinute: 30 } }) }), 'edita campanha running');
  assert(edited.status === 'running' && edited.current_version === 2 && edited.lock_version === 3, 'edição running não publicou v2');
  const versions = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/versions`, { headers: auth }), 'lista versões');
  assert(JSON.stringify(versions.map((item) => item.version)) === JSON.stringify([2, 1]), 'histórico de versões incorreto');
  const versionOne = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/versions/1`, { headers: auth }), 'lê v1');
  assert(versionOne.config_snapshot.rules.maxCallsPerMinute === 20, 'snapshot v1 foi mutado');
  const diff = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/diff?from=1&to=2`, { headers: auth }), 'compara versões');
  assert(diff.changes.some((change) => change.path === 'rules.maxCallsPerMinute' && change.before === 20 && change.after === 30), 'diff não encontrou alteração de ritmo');
  const paused = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/pause`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: 3 }) }), 'pausa campanha');
  const completed = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/complete`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: paused.lock_version }) }), 'conclui campanha');
  const archived = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/archive`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: completed.lock_version }) }), 'arquiva campanha');
  assert(paused.status === 'paused' && completed.status === 'completed' && archived.status === 'archived', 'transições finais inconsistentes');
  const invalid = await request(`/api/tenants/${tenantId}/campaigns/${campaignId}/start`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: archived.lock_version }) });
  assert(invalid.response.status === 409, 'campanha arquivada aceitou transição');
  console.log('Campaign lifecycle OK: wizard contract, publish, optimistic lock, immutable v2, diff, pause, complete and archive.');
} finally { await cleanup(); }
