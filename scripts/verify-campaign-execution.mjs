import pg from 'pg';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env.CAMPAIGN_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.CAMPAIGN_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.CAMPAIGN_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let tenantId = '';
let integrationId = '';

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
const waitFor = async (check, label, attempts = 20) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timeout aguardando ${label}`);
};

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
      'lead_callbacks', 'campaign_event_outbox', 'campaign_playbooks', 'lead_ingestion_outbox', 'lead_ingestion_events',
      'call_decisions', 'decision_campaign_modes', 'decision_policies', 'lead_integrations', 'calls', 'sdr_pauses', 'leads', 'campaigns', 'audit_logs', 'invitations',
      'tenant_memberships', 'websocket_tickets', 'dialer_settings', 'lead_folders', 'sdrs', 'whatsapp_numbers',
    ]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } finally { await pool.end(); }
}

try {
  const login = await expectOk(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await expectOk(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Campaign execution ${suffix}`, slug: `campaign-execution-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
  await expectOk(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ campaigns: true, decision_engine: true }) }), 'habilita campaigns e motor de decisao');

  const folderId = randomUUID();
  const sdrId = randomUUID();
  const numberId = randomUUID();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  await pool.query('INSERT INTO lead_folders (id, tenant_id, name, is_active) VALUES ($1,$2,$3,true)', [folderId, tenantId, 'Execution folder']);
  await pool.query('INSERT INTO sdrs (id, tenant_id, name) VALUES ($1,$2,$3)', [sdrId, tenantId, 'Execution SDR']);
  await pool.query("INSERT INTO whatsapp_numbers (id, tenant_id, label, phone, waxum_session_id, status) VALUES ($1,$2,$3,$4,$5,'waiting_for_qr')", [numberId, tenantId, 'Execution line', '5511988880000', `execution-session-${suffix}`]);
  await pool.query('INSERT INTO dialer_settings (tenant_id, running) VALUES ($1, true) ON CONFLICT (tenant_id) DO UPDATE SET running=true', [tenantId]);
  await pool.end();

  const config = { queueStrategy: 'priority_fifo', maxAttemptsPerLead: 4, retryDelayMinutes: 45, maxCallsPerMinute: 20, minSecondsBetweenCalls: 12, timezone: 'America/Sao_Paulo', scheduleWindows: [] };
  const created = await expectOk(await request(`/api/tenants/${tenantId}/campaigns`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `Execution ${suffix}`, folderId, sdrIds: [sdrId], numberIds: [numberId], config }) }), 'cria campanha');
  const published = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: 0 }) }), 'publica campanha');
  const running = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/start`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedLockVersion: published.lock_version }) }), 'inicia campanha');
  assert(running.status === 'running' && running.current_version === 1, 'campanha nÃ£o ficou em operaÃ§Ã£o');

  const integration = await expectOk(await request(`/api/tenants/${tenantId}/lead-integrations`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `CRM ${suffix}`, defaultFolderId: folderId, campaignId: created.id }) }), 'anexa integraÃ§Ã£o');
  integrationId = integration.id;
  const accepted = await expectOk(await request(`/api/v1/lead-integrations/${integration.public_id}/leads`, { method: 'POST', headers: { authorization: `Bearer ${integration.api_key}`, 'idempotency-key': `execution-${suffix}` }, body: JSON.stringify({ name: 'Lead de execuÃ§Ã£o', phone: `551197${String(Date.now()).slice(-8)}`, external_id: `external-${suffix}` }) }), 'ingere lead');
  assert(accepted.accepted === 1, 'ingestÃ£o nÃ£o aceitou o lead');

  const executionPool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:5432/zapcall' });
  const linkedLead = await waitFor(async () => {
    const result = await executionPool.query('SELECT id, campaign_id, campaign_version FROM leads WHERE tenant_id=$1 AND source_integration_id=$2 LIMIT 1', [tenantId, integrationId]);
    return result.rows[0];
  }, 'worker de ingestÃ£o');
  assert(linkedLead.campaign_id === created.id && Number(linkedLead.campaign_version) === 1, 'lead nÃ£o congelou a campanha e a versÃ£o efetiva');
  const outbox = await executionPool.query("SELECT event_type, campaign_id, campaign_version FROM campaign_event_outbox WHERE tenant_id=$1 AND aggregate_type='lead'", [tenantId]);
  assert(outbox.rows.some((row) => row.event_type === 'lead.received' && row.campaign_id === created.id && Number(row.campaign_version) === 1), 'evento lead.received nÃ£o foi registrado no outbox');
  const eligibility = await expectOk(await request(`/api/tenants/${tenantId}/leads/${linkedLead.id}/eligibility?mode=simulation`, { headers: auth }), 'avalia elegibilidade');
  assert(eligibility.mode === 'simulation' && eligibility.eligible === true && eligibility.blockedBy.length === 0, 'contrato de elegibilidade nao aprovou lead elegivel');
  const initialPolicy = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-policy`, { headers: auth }), 'le politica inicial');
  assert(initialPolicy.version === 1 && initialPolicy.mode === 'shadow', 'politica inicial nao ficou versionada em modo sombra');
  const simulation = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-policy/simulate`, { method: 'POST', headers: auth, body: JSON.stringify({ limit: 8 }) }), 'simula fila inteligente');
  assert(simulation.policy.version === 1 && simulation.candidates.some((candidate) => candidate.id === linkedLead.id && candidate.eligibility.eligible === true), 'simulacao nao explicou o lead elegivel');
  const updatedPolicy = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-policy`, { method: 'PUT', headers: auth, body: JSON.stringify({ weights: { ...initialPolicy.weights, fairnessWeight: 125 }, rationale: 'Ajuste controlado para o smoke test' }) }), 'versiona politica');
  assert(updatedPolicy.version === 2 && updatedPolicy.weights.fairnessWeight === 125, 'politica nao criou a proxima versao');
  const shadowMode = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-mode`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'shadow' }) }), 'ativa modo sombra');
  assert(shadowMode.mode === 'shadow', 'modo sombra nao foi persistido');
  const comparison = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-comparison`, { headers: auth }), 'le comparacao da fila');
  assert(comparison.mode === 'shadow' && Array.isArray(comparison.decisions), 'comparacao nao retornou contrato esperado');
  const shadowDecision = await waitFor(async () => {
    const result = await executionPool.query('SELECT policy_version, feature_snapshot::text AS feature_snapshot, final_decision FROM call_decisions WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT 1', [tenantId, created.id]);
    return result.rows[0];
  }, 'registro sombra do tick');
  assert(shadowDecision.policy_version >= 1 && shadowDecision.final_decision === 'fifo' && !shadowDecision.feature_snapshot.includes('Lead de execu'), 'registro sombra nao preservou a decisao FIFO sem PII');
  const activeMode = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-mode`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'active' }) }), 'ativa fila inteligente');
  assert(activeMode.mode === 'active', 'modo ativo nao foi persistido');
  const killSwitch = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-mode`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'disabled' }) }), 'desliga fila inteligente');
  assert(killSwitch.mode === 'disabled', 'kill switch da campanha nao retornou disabled');
  await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/decision-mode`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'shadow' }) }), 'restaura modo sombra');
  await executionPool.query('UPDATE leads SET do_not_call = true WHERE tenant_id=$1 AND id=$2', [tenantId, linkedLead.id]);
  const blocked = await expectOk(await request(`/api/tenants/${tenantId}/leads/${linkedLead.id}/eligibility?mode=preview`, { headers: auth }), 'explica bloqueio de supressao');
  assert(blocked.eligible === false && blocked.blockedBy.includes('contact_suppressed'), 'contrato de elegibilidade nao explicou a supressao');
  await executionPool.query('UPDATE leads SET do_not_call = false WHERE tenant_id=$1 AND id=$2', [tenantId, linkedLead.id]);
  await executionPool.end();

  const playbook = await expectOk(await request(`/api/tenants/${tenantId}/campaigns/${created.id}/playbook`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `Playbook ${suffix}` }) }), 'salva playbook');
  const playbooks = await expectOk(await request(`/api/tenants/${tenantId}/campaign-playbooks`, { headers: auth }), 'lista playbooks');
  assert(playbooks.some((item) => item.id === playbook.id && item.source_campaign_id === created.id), 'playbook nÃ£o apareceu no tenant correto');
  const instantiated = await expectOk(await request(`/api/tenants/${tenantId}/campaign-playbooks/${playbook.id}/instantiate`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `From playbook ${suffix}` }) }), 'instancia playbook');
  assert(instantiated.status === 'draft' && instantiated.current_version === null, 'playbook nÃ£o gerou novo rascunho');

  console.log('Campaign execution OK: integraÃ§Ã£o anexada, lead com campanha/versÃ£o congeladas, outbox transacional e playbook salvo/instanciado.');
} finally { await cleanup(); }
