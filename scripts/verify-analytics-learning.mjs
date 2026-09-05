import pg from 'pg';

const baseUrl = process.env.ANALYTICS_API_URL ?? 'http://127.0.0.1:3000';
const adminEmail = process.env.ANALYTICS_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.ANALYTICS_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
let tenantId = '';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@127.0.0.1:55432/zapcall' });

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};
const ok = async (result, label) => { assert(result.response.ok, `${label}: ${result.response.status} ${JSON.stringify(result.body)}`); return result.body; };

async function cleanup() {
  if (process.env.KEEP_ANALYTICS_FIXTURE === '1' || !tenantId) { await pool.end(); return; }
  await pool.query("UPDATE tenants SET status = 'archived' WHERE id = $1", [tenantId]);
  await pool.query('DELETE FROM number_status_history WHERE number_id IN (SELECT id FROM whatsapp_numbers WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM sdr_availability_history WHERE sdr_id IN (SELECT id FROM sdrs WHERE tenant_id=$1)', [tenantId]);
  for (const table of [
    'analytics_tenant_learning_runs', 'analytics_tenant_signal_snapshots', 'analytics_event_receipts',
    'analytics_reconciliation_runs', 'analytics_event_outbox', 'analytics_events',
    'metrics_daily_rollup', 'lead_stage_history', 'number_status_history', 'sdr_availability_history',
    'call_result_catalog', 'pipeline_stage_catalog',
    'call_decisions', 'decision_campaign_modes', 'decision_policies', 'audit_logs', 'tenant_memberships',
    'dialer_settings', 'campaign_playbooks', 'campaign_event_outbox', 'lead_ingestion_outbox',
    'lead_ingestion_events', 'lead_integrations', 'campaigns', 'sdr_pauses', 'calls', 'leads',
    'lead_folders', 'sdrs', 'whatsapp_numbers', 'tenant_feature_flags',
  ]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  // O dialer tem um tick de 1s que garante a linha de configurações para
  // tenants ativos. O arquivamento acima interrompe novos ticks, mas uma
  // execução já em voo pode recriar a linha entre o loop e o delete final.
  // Repetir a remoção deixa o smoke test determinístico sem afetar outros
  // tenants do banco compartilhado.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pool.query('DELETE FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
    try {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await pool.end();
}

async function seedCalls() {
  const folderId = `learning-folder-${suffix}`;
  const numberId = `learning-number-${suffix}`;
  const sdrId = `learning-sdr-${suffix}`;
  await pool.query('INSERT INTO lead_folders (id, tenant_id, name, is_active) VALUES ($1,$2,$3,true)', [folderId, tenantId, 'Learning fixture']);
  await pool.query("INSERT INTO whatsapp_numbers (id, tenant_id, label, phone, waxum_session_id, status) VALUES ($1,$2,'Learning fixture line',$3,$4,'waiting_for_qr')", [numberId, tenantId, `5511998${String(Date.now()).slice(-7)}`, `learning-session-${suffix}`]);
  await pool.query('INSERT INTO sdrs (id, tenant_id, name) VALUES ($1,$2,$3)', [sdrId, tenantId, 'Learning fixture SDR']);
  await pool.query('INSERT INTO dialer_settings (tenant_id, running) VALUES ($1, false) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
  const folder = { id: folderId };
  const number = { id: numberId };
  const sdr = { id: sdrId };
  assert(folder && number && sdr, 'tenant criado sem recursos padrão para o fixture');
  for (let index = 0; index < 40; index += 1) {
    const leadId = `learning-lead-${suffix}-${index}`;
    const callId = `learning-call-${suffix}-${index}`;
    const createdAt = new Date(Date.now() - (index + 1) * 60 * 60 * 1000);
    const connectedAt = new Date(createdAt.getTime() + 30_000);
    await pool.query(`INSERT INTO leads (id, tenant_id, folder_id, name, phone, status, attempts, created_at, queued_at, pipeline_stage)
      VALUES ($1,$2,$3,$4,$5,'completed',1,$6,$6,'qualificado')`, [leadId, tenantId, folder.id, `Fixture ${index}`, `551199900${String(index).padStart(4, '0')}`, createdAt]);
    await pool.query(`INSERT INTO calls (id, tenant_id, folder_id, lead_id, number_id, sdr_id, status, attempt_number, created_at, connected_at, ended_at, duration_seconds, connected_duration_seconds, source, call_result, pipeline_stage)
      VALUES ($1,$2,$3,$4,$5,$6,'completed',1,$7,$8,$9,90,60,'automatico',$10,'qualificado')`, [callId, tenantId, folder.id, leadId, number.id, sdr.id, createdAt, connectedAt, new Date(connectedAt.getTime() + 60_000), index % 5 === 0 ? 'sem_interesse' : 'interessado']);
    await pool.query(`INSERT INTO analytics_events (id, tenant_id, event_type, schema_version, aggregate_type, aggregate_id, idempotency_key, payload, occurred_at)
      VALUES ($1,$2,'call.ended',1,'call',$3,$4,$5::jsonb,$6)`, [`learning-event-${suffix}-${index}`, tenantId, callId, `learning-call.ended:${callId}`, JSON.stringify({ status: 'completed', outcome: 'completed' }), createdAt]);
    await pool.query(`INSERT INTO analytics_event_outbox (id, tenant_id, event_id, subject, payload) VALUES ($1,$2,$3,'zapliga.analytics.events',$4::jsonb)`, [`learning-outbox-${suffix}-${index}`, tenantId, `learning-event-${suffix}-${index}`, JSON.stringify({ eventId: `learning-event-${suffix}-${index}` })]);
  }
}

try {
  const login = await ok(await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) }), 'login admin');
  const token = login.accessToken;
  const tenant = await ok(await request('/api/tenants', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: `Learning ${suffix}`, slug: `learning-${suffix}` }) }), 'cria tenant');
  tenantId = tenant.id;
  const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };
  await ok(await request(`/api/tenants/${tenantId}/feature-flags`, { method: 'PATCH', headers: auth, body: JSON.stringify({ analytics_learning: true, decision_engine: true, schedule_enforcement: false }) }), 'habilita aprendizado');
  await seedCalls();
  const reconciliation = await ok(await request(`/api/tenants/${tenantId}/analytics/reconcile`, { method: 'POST', headers: auth }), 'reconcilia chamadas');
  assert(reconciliation.sourceCalls === 40 && reconciliation.eventCalls === 40, `cobertura não fechou: ${JSON.stringify(reconciliation)}`);
  assert(reconciliation.status === 'reliable', `fixture deveria estar confiável: ${reconciliation.status}`);
  const rebuilt = await ok(await request(`/api/tenants/${tenantId}/analytics/learning/rebuild`, { method: 'POST', headers: auth }), 'rebuild tenant');
  assert(rebuilt.snapshotCount >= 8 && rebuilt.status === 'completed', `rebuild incompleto: ${JSON.stringify(rebuilt)}`);
  const insights = await ok(await request(`/api/tenants/${tenantId}/analytics/learning/insights`, { headers: auth }), 'lista insights');
  assert(insights.status === 'ready' && insights.insights.length >= 1, `insights não ficaram prontos: ${JSON.stringify(insights)}`);
  assert(insights.insights.every((item) => item.sampleSize >= 20 && item.denominator >= 20 && item.period?.from && item.period?.to), 'insight sem amostra/período/denominador');
  const aggregates = await ok(await request(`/api/tenants/${tenantId}/analytics/learning/aggregates?dimension=day_hour`, { headers: auth }), 'lista agregados');
  assert(aggregates.items.length >= 1 && aggregates.items.every((item) => item.rawMetrics && item.smoothedMetrics), 'agregado sem métrica bruta e suavizada');
  const monitor = await ok(await request(`/api/tenants/${tenantId}/analytics/learning/monitor`, { headers: auth }), 'monitora estabilidade e seleção');
  assert(monitor.stability && monitor.selectionBias && monitor.formulaVersion === 1, `monitor incompleto: ${JSON.stringify(monitor)}`);
  console.log(JSON.stringify({ ok: true, tenantId, sourceCalls: reconciliation.sourceCalls, snapshots: rebuilt.snapshotCount, insights: insights.insights.length, reliability: reconciliation.status, stability: monitor.stability.status, selection: monitor.selectionBias.status }));
} finally {
  await cleanup();
}
