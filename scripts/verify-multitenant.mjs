import pg from 'pg';

const baseUrl = process.env.SMOKE_API_URL ?? 'http://localhost:3000';
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? 'admin@zapliga.local';
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const legacyTenantId = process.env.SMOKE_LEGACY_TENANT_ID ?? 'tenant-legado';
const slug = `smoke-${Date.now()}`;
let temporaryTenantId;
const temporaryTenantIds = [];
const temporaryUserIds = [];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers ?? {}), 'content-type': 'application/json' },
  });
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  return { response, body };
};

const cookieFrom = (response) => {
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((value) => value.split(';', 1)[0]).find((value) => value.startsWith('zapcall_refresh='));
};

const cleanup = async () => {
  if (temporaryTenantId) temporaryTenantIds.push(temporaryTenantId);
  if (!temporaryTenantIds.length && !temporaryUserIds.length) return;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@localhost:5432/zapcall' });
  try {
    for (const tenantId of new Set(temporaryTenantIds)) {
      // Retire primeiro para impedir que o tick recrie settings durante o cleanup.
      await pool.query("UPDATE tenants SET status = 'archived' WHERE id = $1", [tenantId]);
      // Remove dependências explicitamente porque algumas tabelas legadas
      // (como lead_folders) mantêm RESTRICT no FK de tenant. As tabelas novas
      // também ficam limpas antes de excluir o tenant, mantendo o smoke
      // repetível sem deixar lixo entre execuções.
      for (const table of [
        'data_subject_exports', 'data_subject_request_events', 'data_subject_requests',
        'tenant_onboarding_steps', 'tenant_feature_flags',
        'dialer_schedule_exceptions', 'dialer_schedule_windows',
        'contact_compliance_events', 'contact_suppressions',
        'metric_exports', 'metric_saved_views', 'metric_goals', 'metrics_daily_rollup',
        'lead_stage_history', 'number_status_history', 'sdr_availability_history',
        'recommendation_events', 'operation_recommendations', 'number_health_events', 'operation_health_snapshots',
        'tenant_notes', 'call_result_catalog', 'pipeline_stage_catalog',
        'lead_callbacks', 'call_decisions', 'decision_campaign_modes', 'decision_policies', 'calls', 'sdr_pauses', 'leads', 'audit_logs', 'invitations',
        'campaign_event_outbox', 'campaign_playbooks', 'lead_ingestion_outbox', 'lead_ingestion_events', 'lead_integrations',
        'tenant_memberships', 'websocket_tickets', 'dialer_settings',
        'campaigns', 'lead_folders', 'sdrs', 'whatsapp_numbers',
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      }
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    for (const userId of temporaryUserIds) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  } finally {
    await pool.end();
  }
};

try {
  const health = await fetch(`${baseUrl}/health`);
  assert(health.ok, `health falhou: ${health.status}`);

  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword }) });
  assert(login.response.status === 201 && login.body?.accessToken, `login falhou: ${login.response.status}`);
  const accessToken = login.body.accessToken;
  const auth = { authorization: `Bearer ${accessToken}` };

  const me = await request('/api/auth/me', { headers: auth });
  assert(me.response.ok && me.body?.user?.platformRole === 'super_admin', 'me não identificou o Admin supremo');

  const registrationEmail = `organizer-${Date.now()}@zapliga-smoke.local`;
  const registration = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Organizador Smoke', email: registrationEmail, password: 'OrganizerSmoke2026', companyName: 'Empresa Smoke Organizer', companySlug: `empresa-smoke-${Date.now()}`, legalAccepted: true }) });
  assert(registration.response.status === 201 && registration.body?.accessToken && registration.body?.user?.platformRole === 'user' && registration.body?.tenant?.role === 'leader', `cadastro de organizador falhou: ${registration.response.status}`);
  temporaryTenantIds.push(registration.body.tenant.id);
  temporaryUserIds.push(registration.body.user.id);
  const organizerAuth = { authorization: `Bearer ${registration.body.accessToken}` };
  assert(registration.body.verificationToken, 'ambiente smoke não expôs token de verificação controlado');
  const verification = await request('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token: registration.body.verificationToken }) });
  assert(verification.response.ok, `verificação de e-mail falhou: ${verification.response.status}`);
  const organizerMe = await request('/api/auth/me', { headers: organizerAuth });
  assert(organizerMe.response.ok && organizerMe.body?.tenants?.some((tenant) => tenant.id === registration.body.tenant.id && tenant.role === 'leader'), 'organizador não recebeu membership leader');
  const sdrInvite = await request(`/api/tenants/${registration.body.tenant.id}/sdrs/invitations`, { method: 'POST', headers: organizerAuth, body: JSON.stringify({ name: 'SDR Smoke', email: `sdr-${Date.now()}@zapliga-smoke.local` }) });
  assert(sdrInvite.response.status === 201 && sdrInvite.body?.role === 'sdr' && sdrInvite.body?.invitationUrl, `organizador não conseguiu gerar link de SDR: ${sdrInvite.response.status}`);
  const invitationToken = String(sdrInvite.body?.invitationUrl ?? '').split('/').pop();
  const invitationPreview = await request(`/api/invitations/${encodeURIComponent(invitationToken)}`);
  assert(invitationPreview.response.ok && invitationPreview.body?.role === 'sdr' && invitationPreview.body?.name === 'SDR Smoke', 'convite de SDR não foi criado corretamente');
  const acceptedSdr = await request(`/api/invitations/${encodeURIComponent(invitationToken)}/accept`, { method: 'POST', body: JSON.stringify({ name: 'SDR Smoke', password: 'SdrSmokePassword2026' }) });
  assert(acceptedSdr.response.status === 201 && acceptedSdr.body?.tenant?.role === 'sdr', `aceite do convite de SDR falhou: ${acceptedSdr.response.status}`);
  temporaryUserIds.push(acceptedSdr.body.user.id);
  const sdrList = await request(`/api/tenants/${registration.body.tenant.id}/sdrs`, { headers: organizerAuth });
  assert(sdrList.response.ok && sdrList.body?.items?.some((sdr) => sdr.user_id === acceptedSdr.body.user.id && sdr.user_email), 'perfil operacional do SDR não foi vinculado ao usuário');
  const blockedSdr = await request(`/api/tenants/${registration.body.tenant.id}/members/${acceptedSdr.body.user.id}/status`, { method: 'PATCH', headers: organizerAuth, body: JSON.stringify({ status: 'blocked' }) });
  assert(blockedSdr.response.ok, `organizador não conseguiu bloquear SDR: ${blockedSdr.response.status}`);
  const activatedSdr = await request(`/api/tenants/${registration.body.tenant.id}/members/${acceptedSdr.body.user.id}/status`, { method: 'PATCH', headers: organizerAuth, body: JSON.stringify({ status: 'active' }) });
  assert(activatedSdr.response.ok, `organizador não conseguiu reativar SDR: ${activatedSdr.response.status}`);
  const pendingSdr = await request(`/api/tenants/${registration.body.tenant.id}/sdrs/invitations`, { method: 'POST', headers: organizerAuth, body: JSON.stringify({ name: 'SDR Reenvio', email: `resend-${Date.now()}@zapliga-smoke.local` }) });
  assert(pendingSdr.response.status === 201 && pendingSdr.body?.invitationUrl, `não foi possível criar convite para teste de novo link: ${pendingSdr.response.status}`);
  const previousInvitationToken = String(pendingSdr.body.invitationUrl).split('/').pop();
  const resentSdr = await request(`/api/tenants/${registration.body.tenant.id}/sdrs/invitations/${pendingSdr.body.id}/resend`, { method: 'POST', headers: organizerAuth });
  assert(resentSdr.response.status === 201 && resentSdr.body?.role === 'sdr' && resentSdr.body?.invitationUrl && resentSdr.body.id === pendingSdr.body.id, `reenvio sem convite concorrente falhou: ${resentSdr.response.status}`);
  const previousInvitation = await request(`/api/invitations/${encodeURIComponent(previousInvitationToken)}`);
  assert(previousInvitation.response.status === 404, 'o link anterior continuou válido após gerar um novo');
  const revokedSdr = await request(`/api/tenants/${registration.body.tenant.id}/invitations/${resentSdr.body.id}`, { method: 'DELETE', headers: organizerAuth });
  assert(revokedSdr.response.ok, `revogação de convite SDR falhou: ${revokedSdr.response.status}`);
  const roleInjection = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Role Injection', email: `role-${Date.now()}@zapliga-smoke.local`, password: 'OrganizerSmoke2026', companyName: 'Role Injection', role: 'sdr' }) });
  assert(roleInjection.response.status === 400, `cadastro com papel SDR deveria ser rejeitado: ${roleInjection.response.status}`);

  const explicit = await request(`/api/tenants/${legacyTenantId}/leads`, { headers: { ...auth, 'x-tenant-id': legacyTenantId } });
  assert(explicit.response.ok, `rota explícita de leads falhou: ${explicit.response.status}`);
  const legacy = await request('/api/leads', { headers: { ...auth, 'x-tenant-id': legacyTenantId } });
  assert(legacy.response.ok, `alias legado de leads falhou: ${legacy.response.status}`);
  const missingTenant = await request('/api/leads', { headers: auth });
  assert(missingTenant.response.status === 401, `rota sem tenant deveria ser 401, foi ${missingTenant.response.status}`);
  const mismatch = await request(`/api/tenants/${legacyTenantId}/leads`, { headers: { ...auth, 'x-tenant-id': 'tenant-inexistente' } });
  assert(mismatch.response.status === 401, `tenant divergente deveria ser 401, foi ${mismatch.response.status}`);

  const createdTenant = await request('/api/tenants', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Smoke Tenant', slug }) });
  assert(createdTenant.response.status === 201 && createdTenant.body?.id, `criação de tenant falhou: ${createdTenant.response.status}`);
  temporaryTenantId = createdTenant.body.id;

  for (const route of ['leads', 'callbacks', 'privacy/requests', 'dialer/schedule', 'feature-flags', 'onboarding', 'contact-suppressions']) {
    const isolated = await request(`/api/tenants/${temporaryTenantId}/${route}`, { headers: { ...organizerAuth, 'x-tenant-id': temporaryTenantId } });
    assert(isolated.response.status === 401, `${route} atravessou tenant sem membership: ${isolated.response.status}`);
  }

  const limits = await request(`/api/tenants/${temporaryTenantId}/limits`, { method: 'PATCH', headers: auth, body: JSON.stringify({ maxLeads: 10, maxNumbers: 2, maxSdrs: 2 }) });
  assert(limits.response.ok, `limites do tenant falharam: ${limits.response.status}`);

  const phone = `55119${String(Date.now()).slice(-8)}`;
  const createdLead = await request(`/api/tenants/${temporaryTenantId}/leads`, { method: 'POST', headers: { ...auth, 'x-tenant-id': temporaryTenantId }, body: JSON.stringify({ name: 'Smoke Lead', phone }) });
  assert(createdLead.response.status === 201 && createdLead.body?.id, `lead do tenant falhou: ${createdLead.response.status}`);
  const crossTenant = await request(`/api/tenants/${legacyTenantId}/leads/${createdLead.body.id}/reset`, { method: 'POST', headers: { ...auth, 'x-tenant-id': legacyTenantId } });
  assert(crossTenant.response.status === 404, `IDOR entre tenants deveria ser 404, foi ${crossTenant.response.status}`);

  const invalid = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: adminEmail, password: adminPassword, unexpected: true }) });
  assert(invalid.response.status === 400, `DTO desconhecido deveria ser 400, foi ${invalid.response.status}`);
  const ticket = await request('/api/auth/ws-ticket', { method: 'POST', headers: { ...auth, 'x-tenant-id': legacyTenantId } });
  assert(ticket.response.status === 403, `Admin não deveria obter ticket SDR: ${ticket.response.status}`);

  const refreshCookie = cookieFrom(login.response);
  assert(refreshCookie, 'login não retornou refresh cookie');
  const refreshed = await request('/api/auth/refresh', { method: 'POST', headers: { cookie: refreshCookie } });
  assert(refreshed.response.status === 201 && refreshed.body?.accessToken, `refresh falhou: ${refreshed.response.status}`);
  const rotatedCookie = cookieFrom(refreshed.response);
  assert(rotatedCookie, 'refresh não rotacionou cookie');
  const reused = await request('/api/auth/refresh', { method: 'POST', headers: { cookie: refreshCookie } });
  assert(reused.response.status === 201 && reused.body?.accessToken, `refresh concorrente dentro da janela de graça falhou: ${reused.response.status}`);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie: rotatedCookie } });
  assert(logout.response.ok, `logout falhou: ${logout.response.status}`);

  console.log('Smoke multi-tenant OK: autenticação, novas rotas, tenant explícito, mismatch, quotas, IDOR, DTO, ticket e refresh rotativo.');
} finally {
  await cleanup();
}
