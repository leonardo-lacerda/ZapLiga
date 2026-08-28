import pg from 'pg';

const baseUrl = process.env.SMOKE_API_URL ?? 'http://localhost:3000';
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? 'admin@zapcall.local';
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const legacyTenantId = process.env.SMOKE_LEGACY_TENANT_ID ?? 'tenant-legado';
const slug = `smoke-${Date.now()}`;
let temporaryTenantId;

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
  if (!temporaryTenantId) return;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://zapcall:zapcall@localhost:5432/zapcall' });
  try {
    for (const table of ['calls', 'sdr_pauses', 'audit_logs', 'invitations', 'tenant_memberships', 'websocket_tickets', 'dialer_settings', 'sdrs', 'whatsapp_numbers', 'leads']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [temporaryTenantId]);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [temporaryTenantId]);
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
  assert(reused.response.status === 401, `refresh antigo deveria ser rejeitado: ${reused.response.status}`);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie: rotatedCookie } });
  assert(logout.response.ok, `logout falhou: ${logout.response.status}`);

  console.log('Smoke multi-tenant OK: autenticação, tenant explícito, alias compatível, mismatch, quotas, IDOR, DTO, ticket e refresh rotativo.');
} finally {
  await cleanup();
}
