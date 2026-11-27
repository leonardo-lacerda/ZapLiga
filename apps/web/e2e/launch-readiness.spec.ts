import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import WebSocket from 'ws';
import { connect as connectNats, StringCodec } from 'nats';

const apiBase = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
const wsBase = apiBase.replace(/^http/, 'ws');
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const initialPassword = 'Launch!23456';
const changedPassword = 'Changed!23456';
const e2eAdminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@zapliga.local';
const e2eAdminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'ZapCall-Smoke-2026!';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_e2e';
const billingPool = new Pool({
  host: process.env.BILLING_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.BILLING_PG_PORT ?? process.env.POSTGRES_HOST_PORT ?? 5432),
  database: 'zapcall',
  user: 'zapcall',
  password: 'zapcall',
});

let leaderToken = '';
let adminToken = '';
let leaderEmail = `leader-${suffix}@example.test`;
let tenantA = '';
let ownerBToken = '';
let tenantB = '';
let sdrToken = '';
let sdrId = '';
let control: WebSocket;
let callbackId = '';
// Celular da equipe que recebe o canário das linhas novas.
const teamPhone = `55279${String(Date.now()).slice(-8)}`;
let canaryCallId = '';
// Publica um evento como o Waxum publica no NATS (wa.events.<sessão>.<tipo>).
async function publishWaxumEvent(sessionId: string, type: string, data: Record<string, unknown>) {
  const nats = await connectNats({ servers: process.env.E2E_NATS_URL ?? 'nats://127.0.0.1:4222' });
  nats.publish(`wa.events.${sessionId}.${type}`, StringCodec().encode(JSON.stringify({ session_id: sessionId, event: type, data })));
  await nats.drain();
}
async function openStation(api: any) {
  const ticket = await expectOk(await api.post('/api/auth/ws-ticket', { headers: headers(sdrToken, tenantA) }));
  control = new WebSocket(`${wsBase}/ws/tenants/${tenantA}/sdr?ticket=${encodeURIComponent(ticket.ticket)}`);
  await new Promise<void>((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
  control.send(JSON.stringify({ type: 'identify', sessionId: `e2e-station-${suffix}-${Date.now()}` }));
  return waitForWs('identified');
}
let numberId = '';
let suppressedLeadId = '';
const suppressedPhone = `55119${String(Date.now()).slice(-8)}`;

const headers = (token: string, tenantId?: string) => ({ authorization: `Bearer ${token}`, ...(tenantId ? { 'x-tenant-id': tenantId } : {}) });
const tokenFromInvitation = (url: string) => decodeURIComponent(url.split('/').pop()!);
const expectOk = async (response: any) => {
  const body = await response.json().catch(async () => ({ error: await response.text() }));
  expect(response.ok(), `${response.url()} ${JSON.stringify(body)}`).toBeTruthy();
  return body;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(predicate: () => Promise<T | false>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value as T;
    await delay(500);
  }
  throw new Error(`Timeout: ${label}`);
}

async function context() { return playwrightRequest.newContext({ baseURL: apiBase }); }
async function seedBillingCatalog() {
  await billingPool.query("UPDATE billing_plan_versions SET status = 'active', effective_from = COALESCE(effective_from, now()) WHERE id IN ('plan_starter_v1', 'plan_growth_v1', 'plan_pro_v1')");
  await billingPool.query(`
    INSERT INTO billing_plan_prices (id, plan_version_id, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active)
    VALUES
      ('e2e-starter-month', 'plan_starter_v1', 'price_e2e_starter_month', false, 'brl', 8990, 'month', 1, true),
      ('e2e-starter-year', 'plan_starter_v1', 'price_e2e_starter_year', false, 'brl', 89900, 'year', 1, true),
      ('e2e-growth-month', 'plan_growth_v1', 'price_e2e_growth_month', false, 'brl', 24990, 'month', 1, true),
      ('e2e-growth-year', 'plan_growth_v1', 'price_e2e_growth_year', false, 'brl', 249900, 'year', 1, true),
      ('e2e-pro-month', 'plan_pro_v1', 'price_e2e_pro_month', false, 'brl', 59990, 'month', 1, true),
      ('e2e-pro-year', 'plan_pro_v1', 'price_e2e_pro_year', false, 'brl', 599900, 'year', 1, true)
    ON CONFLICT (id) DO UPDATE SET active = true, stripe_price_id = EXCLUDED.stripe_price_id, unit_amount = EXCLUDED.unit_amount, billing_interval = EXCLUDED.billing_interval
  `);
  await billingPool.query(`
    INSERT INTO billing_addon_prices (id, addon_code, version, display_name, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active)
    VALUES
      ('e2e-sdr-seat-month', 'sdr_seat', 1, 'SDR adicional', 'price_e2e_sdr_month', false, 'brl', 1990, 'month', 1, true),
      ('e2e-sdr-seat-year', 'sdr_seat', 1, 'SDR adicional', 'price_e2e_sdr_year', false, 'brl', 19900, 'year', 1, true)
    ON CONFLICT (addon_code, version, billing_interval, livemode) DO UPDATE SET active = true, stripe_price_id = EXCLUDED.stripe_price_id, unit_amount = EXCLUDED.unit_amount, updated_at = now()
  `);
}
async function activateGrowthPlan(tenantId: string) {
  await billingPool.query("UPDATE billing_plan_versions SET status = 'active', effective_from = COALESCE(effective_from, now()) WHERE id = 'plan_growth_v1'");
  await billingPool.query(`
    INSERT INTO billing_plan_prices (id, plan_version_id, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active)
    VALUES ('e2e-growth-month', 'plan_growth_v1', 'price_e2e_growth_month', false, 'brl', 24990, 'month', 1, true)
    ON CONFLICT (id) DO UPDATE SET active = true, stripe_price_id = EXCLUDED.stripe_price_id, unit_amount = EXCLUDED.unit_amount
  `);
  await billingPool.query(`
    INSERT INTO billing_addon_prices (id, addon_code, version, display_name, stripe_price_id, livemode, currency, unit_amount, billing_interval, interval_count, active)
    VALUES ('e2e-sdr-seat-month', 'sdr_seat', 1, 'SDR adicional', 'price_e2e_sdr_month', false, 'brl', 1990, 'month', 1, true)
    ON CONFLICT (addon_code, version, billing_interval, livemode) DO UPDATE SET active = true, stripe_price_id = EXCLUDED.stripe_price_id, unit_amount = EXCLUDED.unit_amount
  `);
  const customerId = `cus_e2e_${tenantId}`;
  await billingPool.query(`
    INSERT INTO tenant_billing_accounts (tenant_id, stripe_customer_id, livemode)
    VALUES ($1, $2, false)
    ON CONFLICT (tenant_id, livemode) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()
  `, [tenantId, customerId]);
  const now = Math.floor(Date.now() / 1000);
  const event = {
    id: `evt_e2e_${tenantId}`,
    type: 'customer.subscription.pending_update_applied',
    livemode: false,
    api_version: '2025-06-30.basil',
    created: now,
    data: { object: {
      id: `sub_e2e_${tenantId}`,
      customer: customerId,
      status: 'active',
      current_period_start: now,
      current_period_end: now + 30 * 24 * 60 * 60,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      latest_invoice: `in_e2e_${tenantId}`,
      metadata: { tenant_id: tenantId },
      items: { data: [
        { id: `si_e2e_base_${tenantId}`, price: { id: 'price_e2e_growth_month' }, quantity: 1 },
        { id: `si_e2e_seat_${tenantId}`, price: { id: 'price_e2e_sdr_month' }, quantity: 2 },
      ] },
    } },
  };
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', stripeWebhookSecret).update(`${timestamp}.${payload}`).digest('hex');
  const api = await context();
  await expectOk(await api.post('/api/billing/stripe/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` }, data: payload }));
  await waitFor(async () => {
    const current = await api.get(`/api/tenants/${tenantId}/billing`, { headers: headers(adminToken, tenantId) });
    if (!current.ok()) return false;
    const body = await current.json();
    return body.mode === 'full' && body.planCode === 'growth';
  }, `plano Growth ativo para ${tenantId}`);
  await api.dispose();
}
async function register(email: string, companyName: string) {
  const api = await context();
  const body = await expectOk(await api.post('/api/auth/register', { data: { name: 'Lider E2E', email, password: initialPassword, companyName, companySlug: `${companyName}-${suffix}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), legalAccepted: true } }));
  await expectOk(await api.post('/api/auth/email/verify', { data: { token: body.verificationToken } }));
  await api.dispose();
  return body;
}
async function waitForWs(type: string, timeout = 12_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout aguardando ${type}`)); }, timeout);
    const listener = (raw: WebSocket.RawData, binary: boolean) => {
      if (binary) return;
      try { const message = JSON.parse(raw.toString()); if (message.type === type) { cleanup(); resolve(message); } } catch { /* ignore */ }
    };
    const cleanup = () => { clearTimeout(timer); control.off('message', listener); };
    control.on('message', listener);
  });
}
async function waitForBinary(timeout = 12_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timeout aguardando áudio do cliente')); }, timeout);
    const listener = (raw: WebSocket.RawData, binary: boolean) => {
      if (!binary) return;
      cleanup();
      resolve(Buffer.from(raw as any));
    };
    const cleanup = () => { clearTimeout(timer); control.off('message', listener); };
    control.on('message', listener);
  });
}
async function waitForPause(api: any) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await api.get(`/api/tenants/${tenantA}/me/sdr`, { headers: headers(sdrToken, tenantA) });
    if (response.ok()) { const state = await response.json(); if (state.current_pause_id) return state; }
    await delay(250);
  }
  throw new Error('Pos-atendimento nao foi aberto');
}

// Ligações só saem por uma linha num PC de atendente online (docs/saida-pelo-pc-do-atendente.md).
// O stack de teste tem um único Waxum (nó "main"): registra um PC nesse slot e renova o
// relatório de rota antes de cada jornada, como o vigia do PC faz a cada 10 s.
async function reportPcOnline() {
  await billingPool.query(`
    INSERT INTO egress_pcs (id, name, slot, tailscale_hostname, route, route_reported_at)
    VALUES ('e2e-pc', 'PC do atendente (E2E)', 'main', 'zapliga-e2e-pc', 'pc', now())
    ON CONFLICT (id) DO UPDATE SET route = 'pc', route_reported_at = now()
  `);
}

test.describe.serial('Gate B - jornadas criticas', () => {
  test.beforeAll(async () => { await seedBillingCatalog(); });
  test.beforeEach(async () => { await reportPcOnline(); });
  test.afterAll(async () => { await billingPool.end(); });

  test('1. cadastro, aceite legal, verificacao e login pela interface', async ({ page }) => {
    await page.goto('/registro');
    await page.getByLabel('Seu nome').fill('Lider E2E');
    await page.getByLabel('E-mail corporativo').fill(leaderEmail);
    await page.getByLabel(/Senha/).fill(initialPassword);
    await page.getByLabel('Nome da empresa').fill(`Tenant A ${suffix}`);
    await page.getByLabel(/Li e aceito/).check();
    const registerResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/register'));
    await page.getByRole('button', { name: 'Criar minha operação' }).click();
    const registration = await registerResponse;
    expect(registration.ok()).toBeTruthy();
    const created = await registration.json();
    tenantA = created.tenant.id;
    await expect(page.getByText('Verifique sua caixa de entrada')).toBeVisible();
    const verifyApi = await context();
    await expectOk(await verifyApi.post('/api/auth/email/verify', { data: { token: created.verificationToken } }));
    await verifyApi.dispose();
    // End the session created by registration so the next step proves the
    // normal login journey through the interface.
    await page.context().request.post(`${apiBase}/api/auth/logout`);
    await page.context().clearCookies();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto('/login');
    await page.getByPlaceholder('voce@empresa.com').fill(leaderEmail);
    await page.getByPlaceholder('Digite sua senha').fill(initialPassword);
    await page.getByRole('button', { name: 'Entrar na central' }).click();
    await expect(page).toHaveURL(/\/app\/?/);
    await page.goto('/app/cobranca');
    await expect(page.getByRole('heading', { name: 'Plano e cobrança' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Adicionar mais SDR' }).first()).toBeVisible();
    const starterPlan = page.locator('.billing-plan-card').filter({ has: page.getByRole('heading', { name: 'Starter', level: 3 }) });
    await expect(starterPlan).toContainText('2 SDRs');
    await expect(starterPlan.getByRole('button', { name: 'Adicionar mais SDR' })).toBeDisabled();
    await expect(starterPlan).toContainText('Limite deste plano atingido');
    await page.goto('/app/');
    const api = await context();
    leaderToken = (await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: initialPassword } }))).accessToken;
    adminToken = (await expectOk(await api.post('/api/auth/login', { data: { email: e2eAdminEmail, password: e2eAdminPassword } }))).accessToken;
    const launchFeatures = ['schedule_enforcement', 'callbacks', 'privacy_requests', 'onboarding'];
    const roadmapFeatures = ['campaigns', 'decision_engine', 'recommendations', 'operation_health', 'analytics_learning', 'experiments', 'benchmarks'];
    const initialFlags = await expectOk(await api.get(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA) }));
    for (const feature of launchFeatures) expect(initialFlags[feature], `${feature} deve nascer ativada`).toBe(true);
    for (const feature of roadmapFeatures) expect(initialFlags[feature], `${feature} deve nascer desativada`).toBe(false);
    const disabledCampaigns = await api.get(`/api/tenants/${tenantA}/campaigns`, { headers: headers(leaderToken, tenantA) });
    expect(disabledCampaigns.status()).toBe(409);
    await expectOk(await api.patch(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA), data: { callbacks: false } }));
    const disabledCallbacks = await api.get(`/api/tenants/${tenantA}/callbacks`, { headers: headers(leaderToken, tenantA) });
    expect(disabledCallbacks.status()).toBe(409);
    await expectOk(await api.patch(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA), data: { callbacks: true } }));
    const updatedFlags = await expectOk(await api.get(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA) }));
    for (const feature of roadmapFeatures) expect(updatedFlags[feature], `${feature} nao deve ser ativada por outra flag`).toBe(false);
    await expectOk(await api.patch(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA), data: { campaigns: true } }));
    await activateGrowthPlan(tenantA);
    await api.dispose();
  });

  test('2. recuperacao e troca de senha sem enumerar usuarios', async () => {
    const api = await context();
    const unknown = await expectOk(await api.post('/api/auth/password/forgot', { data: { email: `missing-${suffix}@example.test` } }));
    const known = await expectOk(await api.post('/api/auth/password/forgot', { data: { email: leaderEmail } }));
    expect(unknown.message).toBe(known.message);
    expect(known.resetToken).toBeTruthy();
    await expectOk(await api.post('/api/auth/password/reset', { data: { token: known.resetToken, password: changedPassword } }));
    expect((await api.post('/api/auth/login', { data: { email: leaderEmail, password: initialPassword } })).status()).toBe(401);
    leaderToken = (await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: changedPassword } }))).accessToken;
    await api.dispose();
  });

  test('3. convites de lider e SDR chegam, abrem e sao aceitos', async () => {
    const api = await context();
    const leaderInvite = await expectOk(await api.post(`/api/tenants/${tenantA}/invitations`, { headers: headers(leaderToken, tenantA), data: { email: `leader2-${suffix}@example.test`, role: 'leader' } }));
    const leaderInviteToken = tokenFromInvitation(leaderInvite.invitationUrl);
    await expectOk(await api.get(`/api/invitations/${leaderInviteToken}`));
    await expectOk(await api.post(`/api/invitations/${leaderInviteToken}/accept`, { data: { name: 'Segundo Lider', password: initialPassword } }));
    // Fixture do Gate B: três SDRs no tenant A, mantendo o primeiro token
    // para as jornadas de discagem/áudio abaixo.
    for (let index = 1; index <= 3; index += 1) {
      const sdrInvite = await expectOk(await api.post(`/api/tenants/${tenantA}/sdrs/invitations`, { headers: headers(leaderToken, tenantA), data: { email: `sdr-${index}-${suffix}@example.test`, name: `SDR E2E ${index}` } }));
      const accepted = await expectOk(await api.post(`/api/invitations/${tokenFromInvitation(sdrInvite.invitationUrl)}/accept`, { data: { name: `SDR E2E ${index}`, password: initialPassword } }));
      if (index === 1) sdrToken = accepted.accessToken;
      await expectOk(await api.post('/api/me/legal-acceptance', { headers: headers(accepted.accessToken) }));
    }
    const fixtureSdrs = await expectOk(await api.get(`/api/tenants/${tenantA}/sdrs`, { headers: headers(leaderToken, tenantA) }));
    expect(fixtureSdrs.items.filter((item: any) => item.user_id).length).toBeGreaterThanOrEqual(3);
    await api.dispose();
  });

  test('4. usuario alterna entre dois tenants sem vazamento', async () => {
    const ownerBEmail = `owner-b-${suffix}@example.test`;
    const createdB = await register(ownerBEmail, 'Tenant B');
    tenantB = createdB.tenant.id; ownerBToken = createdB.accessToken;
    await activateGrowthPlan(tenantB);
    const api = await context();
    await expectOk(await api.patch(`/api/tenants/${tenantB}/feature-flags`, { headers: headers(adminToken, tenantB), data: { campaigns: true } }));
    const invitation = await expectOk(await api.post(`/api/tenants/${tenantB}/invitations`, { headers: headers(ownerBToken, tenantB), data: { email: leaderEmail, role: 'leader' } }));
    const accepted = await expectOk(await api.post(`/api/invitations/${tokenFromInvitation(invitation.invitationUrl)}/accept`, { data: { name: 'Lider E2E', password: changedPassword } }));
    leaderToken = accepted.accessToken;
    const me = await expectOk(await api.get('/api/auth/me', { headers: headers(leaderToken) }));
    expect(new Set(me.tenants.map((item: any) => item.id))).toEqual(new Set([tenantA, tenantB]));
    const isolatedPhone = `55117${String(Date.now()).slice(-8)}`;
    await expectOk(await api.post(`/api/tenants/${tenantA}/leads`, { headers: headers(leaderToken, tenantA), data: { name: 'Somente Tenant A', phone: isolatedPhone } }));
    const a = await expectOk(await api.get(`/api/tenants/${tenantA}/leads`, { headers: headers(leaderToken, tenantA) }));
    const b = await expectOk(await api.get(`/api/tenants/${tenantB}/leads`, { headers: headers(leaderToken, tenantB) }));
    const aItems = Array.isArray(a) ? a : (a.items ?? []);
    const bItems = Array.isArray(b) ? b : (b.items ?? []);
    expect(aItems.some((item: any) => item.phone === isolatedPhone)).toBe(true);
    expect(bItems.some((item: any) => item.phone === isolatedPhone)).toBe(false);
    await api.dispose();
  });

  test('5. campanha legada representa a operacao sem alterar a fila', async () => {
    const api = await context();
    const campaignList = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns`, { headers: headers(leaderToken, tenantA) }));
    expect(campaignList.total).toBe(1);
    expect(campaignList.items[0]).toMatchObject({ tenant_id: tenantA, is_legacy: true, current_version: 1 });

    const campaignId = campaignList.items[0].id;
    const campaign = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns/${campaignId}`, { headers: headers(leaderToken, tenantA) }));
    expect(campaign.current_config).toMatchObject({ schema_version: 1, source: 'legacy_operation', uses_all_active_folders: true });
    expect(campaign.sdr_count).toBeGreaterThanOrEqual(3);
    expect(campaign.sdrs.length).toBeGreaterThanOrEqual(3);

    const crossTenant = await api.get(`/api/tenants/${tenantB}/campaigns/${campaignId}`, { headers: headers(leaderToken, tenantB) });
    expect(crossTenant.status()).toBe(404);
    await api.dispose();
  });

  test('6. conexao de numero usa o fake deterministico e le estado', async () => {
    const api = await context();
    const created = await expectOk(await api.post(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA), data: { label: 'Linha CI', phone: '5511999999999', maxConcurrentCalls: 1, cooldownSeconds: 0 } }));
    numberId = created.id;
    // The deterministic fixture performs two calls in quick succession in
    // journeys 8 and 9. Disable only the operation pacing for this synthetic
    // test; production keeps the conservative defaults from migration 041.
    await expectOk(await api.patch(`/api/tenants/${tenantA}/dialer/settings`, { headers: headers(leaderToken, tenantA), data: { max_calls_per_minute: 60, min_seconds_between_calls: 0 } }));
    await expectOk(await api.get(`/api/tenants/${tenantA}/numbers/${numberId}/qr`, { headers: headers(leaderToken, tenantA) }));
    const numbers = await expectOk(await api.get(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA) }));
    expect(numbers.items).toHaveLength(1);
    expect(numbers.items[0].status).toBe('connected');
    const campaigns = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns`, { headers: headers(leaderToken, tenantA) }));
    expect(campaigns.items[0].number_count).toBe(1);
    await api.dispose();
  });

  test('6b. canario: a linha nova so liga para leads depois de ligar para a equipe', async () => {
    test.setTimeout(120_000);
    const api = await context();
    const lines = async () => (await expectOk(await api.get(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA) }))).items;
    // A jornada roda a qualquer hora: abre a semana inteira, como a 8 faz.
    await expectOk(await api.put(`/api/tenants/${tenantA}/dialer/schedule`, { headers: headers(leaderToken, tenantA), data: { timezone: 'America/Sao_Paulo', windows: Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, start_time: '00:00', end_time: '23:59' })), exceptions: [] } }));
    expect((await lines()).find((line: any) => line.id === numberId).canary_status).toBe('pending');
    // Sem celular da equipe cadastrado, o canário não começa.
    const noPhones = await api.post(`/api/tenants/${tenantA}/numbers/${numberId}/canary/message`, { headers: headers(leaderToken, tenantA) });
    expect(noPhones.ok()).toBeFalsy();
    await expectOk(await api.patch(`/api/tenants/${tenantA}/dialer/settings`, { headers: headers(leaderToken, tenantA), data: { canary_phones: [teamPhone] } }));
    const message = await expectOk(await api.post(`/api/tenants/${tenantA}/numbers/${numberId}/canary/message`, { headers: headers(leaderToken, tenantA) }));
    expect(message.phone).toBe(teamPhone);

    await openStation(api);
    // Canário só liga para um celular da equipe; e a linha pendente não liga para leads.
    const outsider = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(sdrToken, tenantA), data: { phone: '5511988887777', numberId, canary: true } });
    expect(outsider.ok()).toBeFalsy();
    const leadCall = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(sdrToken, tenantA), data: { phone: '5511988886666', numberId } });
    expect(leadCall.ok()).toBeFalsy();
    expect(JSON.stringify(await leadCall.json())).toContain('canário');

    const reservedPromise = waitForWs('call_reserved');
    const answeredPromise = waitForWs('call_started');
    await expectOk(await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(sdrToken, tenantA), data: { phone: teamPhone, numberId, canary: true } }));
    canaryCallId = (await reservedPromise).callId;
    await answeredPromise;
    const resultPromise = waitForWs('canary_result', 60_000);
    await delay(6_000);
    control.send(JSON.stringify({ type: 'hangup', callId: canaryCallId }));
    expect((await resultPromise).result).toBe('passed');
    expect((await lines()).find((line: any) => line.id === numberId).canary_status).toBe('passed');
    const call = (await billingPool.query('SELECT canary, waxum_call_id, offer_sent_at FROM calls WHERE id = $1', [canaryCallId])).rows[0];
    expect(call.canary).toBe(true);
    expect(call.waxum_call_id).toBeTruthy();
    expect(call.offer_sent_at).toBeTruthy();
    const event = (await billingPool.query("SELECT metadata FROM number_health_events WHERE number_id = $1 AND event_type = 'canary_passed'", [numberId])).rows[0];
    expect(event.metadata.lastedSeconds).toBeGreaterThanOrEqual(5);
    control.close();
    await api.dispose();
  });

  test('7. ciclo de campanha publica, versiona edicoes concorrentes e encerra com seguranca', async () => {
    const api = await context();
    const folderPage = await expectOk(await api.get(`/api/tenants/${tenantA}/lead-folders`, { headers: headers(leaderToken, tenantA) }));
    const folderItems = Array.isArray(folderPage) ? folderPage : (folderPage.items ?? []);
    const sdrPage = await expectOk(await api.get(`/api/tenants/${tenantA}/sdrs`, { headers: headers(leaderToken, tenantA) }));
    const campaignFolder = folderItems.find((item: any) => item.is_active) ?? folderItems[0];
    const campaignSdr = (sdrPage.items ?? []).find((item: any) => item.user_id) ?? sdrPage.items?.[0];
    expect(campaignFolder?.id).toBeTruthy();
    expect(campaignSdr?.id).toBeTruthy();

    const config = { queueStrategy: 'priority_fifo', maxAttemptsPerLead: 3, retryDelayMinutes: 60, maxCallsPerMinute: 20, minSecondsBetweenCalls: 10, timezone: 'America/Sao_Paulo', scheduleWindows: [] };
    const created = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns`, { headers: headers(leaderToken, tenantA), data: {
      name: `Campanha versionada ${suffix}`, description: 'Fixture de ciclo completo', folderId: campaignFolder.id,
      primaryGoalMetric: 'qualified_leads', primaryGoalTarget: 10, sdrIds: [campaignSdr.id], numberIds: [numberId], config,
    } }));
    expect(created).toMatchObject({ status: 'draft', current_version: null, lock_version: 0 });
    const campaignId = created.id;

    const published = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/publish`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 0, reason: 'Primeira publicação E2E' } }));
    expect(published).toMatchObject({ status: 'ready', current_version: 1, lock_version: 1 });
    const stale = await api.patch(`/api/tenants/${tenantA}/campaigns/${campaignId}`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 0, description: 'edição atrasada', config } });
    expect(stale.status()).toBe(409);

    const running = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/start`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 1 } }));
    expect(running).toMatchObject({ status: 'running', current_version: 1, lock_version: 2 });
    const edited = await expectOk(await api.patch(`/api/tenants/${tenantA}/campaigns/${campaignId}`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 2, changeReason: 'Ajuste controlado de ritmo', config: { ...config, maxCallsPerMinute: 30 } } }));
    expect(edited).toMatchObject({ status: 'running', current_version: 2, lock_version: 3 });
    const versions = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns/${campaignId}/versions`, { headers: headers(leaderToken, tenantA) }));
    expect(versions.map((item: any) => item.version)).toEqual([2, 1]);
    const versionOne = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns/${campaignId}/versions/1`, { headers: headers(leaderToken, tenantA) }));
    expect(versionOne.config_snapshot.rules.maxCallsPerMinute).toBe(20);
    const versionDiff = await expectOk(await api.get(`/api/tenants/${tenantA}/campaigns/${campaignId}/diff?from=1&to=2`, { headers: headers(leaderToken, tenantA) }));
    expect(versionDiff.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'rules.maxCallsPerMinute', before: 20, after: 30 })]));

    const paused = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/pause`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 3 } }));
    expect(paused).toMatchObject({ status: 'paused', lock_version: 4 });
    const completed = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/complete`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 4 } }));
    expect(completed).toMatchObject({ status: 'completed', lock_version: 5 });
    const archived = await expectOk(await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/archive`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 5 } }));
    expect(archived).toMatchObject({ status: 'archived', lock_version: 6 });
    const invalid = await api.post(`/api/tenants/${tenantA}/campaigns/${campaignId}/start`, { headers: headers(leaderToken, tenantA), data: { expectedLockVersion: 6 } });
    expect(invalid.status()).toBe(409);
    await api.dispose();
  });

  test('8. importacao preserva supressao depois de excluir e reimportar', async () => {
    const api = await context();
    await expectOk(await api.post(`/api/tenants/${tenantA}/leads/import`, { headers: headers(leaderToken, tenantA), multipart: { file: { name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,phone\nTitular E2E,${suppressedPhone}\n`) } } }));
    const leads = await expectOk(await api.get(`/api/tenants/${tenantA}/leads`, { headers: headers(leaderToken, tenantA) }));
    const leadItems = Array.isArray(leads) ? leads : (leads.items ?? []);
    suppressedLeadId = leadItems.find((item: any) => item.phone === suppressedPhone).id;
    await expectOk(await api.post(`/api/tenants/${tenantA}/contact-suppressions`, { headers: headers(leaderToken, tenantA), data: { phone: suppressedPhone, reason: 'requested_opt_out', source: 'lead_action' } }));
    await expectOk(await api.delete(`/api/tenants/${tenantA}/leads/${suppressedLeadId}`, { headers: headers(leaderToken, tenantA) }));
    const recreated = await expectOk(await api.post(`/api/tenants/${tenantA}/leads`, { headers: headers(leaderToken, tenantA), data: { name: 'Titular reimportado', phone: suppressedPhone } }));
    suppressedLeadId = recreated.id;
    expect(recreated.do_not_call).toBe(true);
    await api.dispose();
  });

  test('8. discagem e bloqueada fora do horario', async () => {
    const api = await context();
    await expectOk(await api.put(`/api/tenants/${tenantA}/dialer/schedule`, { headers: headers(leaderToken, tenantA), data: { timezone: 'America/Sao_Paulo', windows: [], exceptions: [] } }));
    const blocked = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(leaderToken, tenantA), data: { phone: '5511988887777', name: 'Bloqueado' } });
    expect(blocked.status()).toBe(409);
    await expectOk(await api.put(`/api/tenants/${tenantA}/dialer/schedule`, { headers: headers(leaderToken, tenantA), data: { timezone: 'America/Sao_Paulo', windows: Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, start_time: '00:00', end_time: '23:59' })), exceptions: [] } }));
    await api.dispose();
  });

  test('9. voz chega ao SDR sem depender do evento Accept e abre pos-atendimento', async () => {
    const api = await context();
    const ticket = await expectOk(await api.post('/api/auth/ws-ticket', { headers: headers(sdrToken, tenantA) }));
    control = new WebSocket(`${wsBase}/ws/tenants/${tenantA}/sdr?ticket=${encodeURIComponent(ticket.ticket)}`);
    await new Promise<void>((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
    control.send(JSON.stringify({ type: 'identify', sessionId: `e2e-${suffix}` }));
    const identified = await waitForWs('identified'); sdrId = identified.sdr.id;
    const startedPromise = waitForWs('call_started');
    const audioPromise = waitForBinary();
    control.send(JSON.stringify({ type: 'availability', available: true }));
    await waitForWs('availability_changed');
    const started = await startedPromise;
    const audio = await audioPromise;
    let peak = 0;
    for (let offset = 0; offset + 1 < audio.length; offset += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(offset)));
    expect(audio.length).toBeGreaterThanOrEqual(640);
    expect(peak).toBeGreaterThanOrEqual(2000);
    await delay(500);
    control.send(JSON.stringify({ type: 'outcome', callId: started.callId, outcome: 'completed' }));
    const pause = await waitForPause(api);
    expect(pause.state).toBe('post_call');
    const dueAt = new Date(Date.now() + 1200).toISOString();
    await expectOk(await api.post(`/api/tenants/${tenantA}/sdrs/${sdrId}/pauses/${pause.current_pause_id}/finish`, { headers: headers(sdrToken, tenantA), data: { callResult: 'retornar', pipelineStage: 'contatado', notes: 'Retorno combinado no teste E2E', callbackAt: dueAt, continueAvailable: false } }));
    await api.dispose();
  });

  test('10. callback vence, e reatribuido e concluido por nova chamada', async () => {
    const api = await context();
    await delay(1400);
    let callbacks = await expectOk(await api.get(`/api/tenants/${tenantA}/callbacks`, { headers: headers(leaderToken, tenantA) }));
    callbackId = callbacks.find((item: any) => item.status === 'due').id;
    await expectOk(await api.patch(`/api/tenants/${tenantA}/callbacks/${callbackId}/reassign`, { headers: headers(leaderToken, tenantA), data: { assignedSdrId: sdrId } }));
    const startedPromise = waitForWs('call_started');
    const call = await expectOk(await api.post(`/api/tenants/${tenantA}/callbacks/${callbackId}/call`, { headers: headers(leaderToken, tenantA) }));
    await startedPromise;
    await delay(500);
    control.send(JSON.stringify({ type: 'outcome', callId: call.callId, outcome: 'completed' }));
    const pause = await waitForPause(api);
    await expectOk(await api.post(`/api/tenants/${tenantA}/sdrs/${sdrId}/pauses/${pause.current_pause_id}/finish`, { headers: headers(sdrToken, tenantA), data: { callResult: 'interessado', pipelineStage: 'qualificado', notes: 'Callback concluído no teste E2E', continueAvailable: false } }));
    callbacks = await expectOk(await api.get(`/api/tenants/${tenantA}/callbacks`, { headers: headers(leaderToken, tenantA) }));
    expect(callbacks.find((item: any) => item.id === callbackId).status).toBe('completed');
    await api.dispose();
  });

  test('11. exportacao e anonimizacao LGPD sao autenticadas e idempotentes', async () => {
    const api = await context();
    const exportRequest = await expectOk(await api.post(`/api/tenants/${tenantA}/privacy/requests`, { headers: headers(leaderToken, tenantA), data: { phone: suppressedPhone, requestType: 'export' } }));
    await expectOk(await api.post(`/api/tenants/${tenantA}/privacy/requests/${exportRequest.id}/process`, { headers: headers(leaderToken, tenantA) }));
    const exported = await expectOk(await api.get(`/api/tenants/${tenantA}/privacy/requests/${exportRequest.id}/export`, { headers: headers(leaderToken, tenantA) }));
    expect(exported.subject.phone).toBe(suppressedPhone);
    const anonymize = await expectOk(await api.post(`/api/tenants/${tenantA}/privacy/requests`, { headers: headers(leaderToken, tenantA), data: { phone: suppressedPhone, requestType: 'anonymization' } }));
    await expectOk(await api.post(`/api/tenants/${tenantA}/privacy/requests/${anonymize.id}/process`, { headers: headers(leaderToken, tenantA) }));
    const repeated = await expectOk(await api.post(`/api/tenants/${tenantA}/privacy/requests/${anonymize.id}/process`, { headers: headers(leaderToken, tenantA) }));
    expect(repeated.status).toBe('completed');
    const suppressions = await expectOk(await api.get(`/api/tenants/${tenantA}/contact-suppressions?search=${suppressedPhone}`, { headers: headers(leaderToken, tenantA) }));
    expect(suppressions.total).toBeGreaterThan(0);
    await api.dispose();
  });

  test('12. revogacao de sessao invalida access token no request seguinte', async () => {
    const api = await context();
    const first = await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: changedPassword } }));
    const second = await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: changedPassword } }));
    const sessions = await expectOk(await api.get('/api/me/sessions', { headers: headers(first.accessToken) }));
    const target = sessions.find((item: any) => !item.current);
    await expectOk(await api.delete(`/api/me/sessions/${target.id}`, { headers: headers(first.accessToken) }));
    expect((await api.get('/api/auth/me', { headers: headers(second.accessToken) })).status()).toBe(401);
    await api.dispose();
  });

  test('13. todas as novas rotas preservam isolamento multitenant', async () => {
    const api = await context();
    const paths = ['dialer/schedule', 'callbacks', 'privacy/requests', 'feature-flags', 'onboarding', 'contact-suppressions', 'campaigns'];
    for (const path of paths) {
      const response = await api.get(`/api/tenants/${tenantA}/${path}`, { headers: headers(ownerBToken, tenantA) });
      expect(response.status(), path).toBe(401);
    }
    control?.close();
    await api.dispose();
  });

  test('14. numeros do cadastro de WhatsApp saem do historico real no Postgres', async () => {
    const api = await context();
    await expectOk(await api.patch(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA), data: { whatsapp_provisioning: true } }));
    const at = (seconds: number) => new Date(Date.now() - 3_600_000 + seconds * 1000).toISOString();
    const history = (...steps: Array<[string, number]>) => JSON.stringify(steps.map(([step, s]) => ({ step, at: at(s), message: null })));
    const insert = (id: string, status: string, step: string, errorCode: string | null, ip: string, version: string, hist: string) => billingPool.query(
      `INSERT INTO provisioning_jobs (id, tenant_id, egress_node, geelark_phone_id, app, phone, status, step, error_code, egress_ip, app_version, history, finished_at, created_at)
       VALUES ($1, $2, 'pc-e2e', 'phone-e2e', 'business', '5527981554290', $3, $4, $5, $6, $7, $8::jsonb, now(), now() - interval '1 hour')`,
      [`${id}-${suffix}`, tenantA, status, step, errorCode, ip, version, hist]);
    await insert('stats-ok', 'done', 'done', null, '45.172.112.163', '2.26.1', history(['queued', 0], ['opening_app', 10], ['waiting_sms', 40], ['done', 100]));
    await insert('stats-fail', 'failed', 'waiting_sms', 'wait_limit', '131.255.254.90', '2.26.1', history(['queued', 0], ['opening_app', 20], ['waiting_sms', 60]));
    const stats = await expectOk(await api.get(`/api/tenants/${tenantA}/provisioning/stats?days=7`, { headers: headers(leaderToken, tenantA) }));
    expect(stats).toMatchObject({ days: 7, total: 2, done: 1, failed: 1, cancelled: 0 });
    expect(stats.failuresByError).toEqual([{ key: 'wait_limit', count: 1 }]);
    expect(stats.failuresByStep).toEqual([{ key: 'waiting_sms', count: 1 }]);
    expect(stats.byAppVersion).toEqual([{ key: 'business 2.26.1', total: 2, done: 1 }]);
    expect(stats.byEgressIp).toHaveLength(2);
    const opening = stats.stepDurations.find((row: any) => row.key === 'opening_app');
    expect(opening).toMatchObject({ count: 2, median_s: 35, max_s: 40 });
    await api.dispose();
  });

  test('15. MCP: a chave do Claude lista ferramentas e le numeros pela API real', async () => {
    const api = await context();
    const created = await expectOk(await api.post(`/api/tenants/${tenantA}/provisioning/mcp-keys`, { headers: headers(leaderToken, tenantA), data: { name: 'Claude E2E' } }));
    expect(created.apiKey).toMatch(/^zpl_mcp_/);
    const mcp = (id: number, method: string, params: Record<string, unknown> = {}, key = created.apiKey) => api.post('/api/mcp', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id, method, params },
    });
    const init = await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    expect(init.status()).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe('zapliga');
    const tools = (await (await mcp(2, 'tools/list')).json()).result.tools.map((tool: any) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['list_numbers', 'open_phone', 'tap', 'start_registration']));
    expect(tools).not.toContain('delete_phone');
    const listed = (await (await mcp(3, 'tools/call', { name: 'list_numbers', arguments: {} })).json()).result;
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(listed.content[0].text).items.map((item: any) => item.label)).toContain('Linha CI');
    expect((await mcp(4, 'tools/list', {}, 'zpl_mcp_invalida')).status()).toBe(401);
    await expectOk(await api.post(`/api/tenants/${tenantA}/provisioning/mcp-keys/${created.id}/revoke`, { headers: headers(leaderToken, tenantA) }));
    expect((await mcp(5, 'tools/list')).status()).toBe(401);
    await api.dispose();
  });

  test('16. queda: conta travada e aparelho removido marcam a linha, e a segunda queda aposenta', async () => {
    const api = await context();
    const line = await expectOk(await api.post(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA), data: { label: 'Linha queda CI', phone: '5511977776666' } }));
    const byId = async () => (await expectOk(await api.get(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA) }))).items.find((item: any) => item.id === line.id);
    expect(line.waxum_node).toBe('main');

    // Um logout comum não é queda.
    await publishWaxumEvent(line.waxum_session_id, 'logged_out', { reason: 'ClientOutdated' });
    await delay(1500);
    expect((await byId()).loss_reason).toBeNull();

    await publishWaxumEvent(line.waxum_session_id, 'logged_out', { reason: 'LoggedOut', conflict: 'device_removed', on_connect: false });
    const removed = await waitFor(async () => { const item = await byId(); return item.loss_reason === 'device_removed' ? item : false; }, 'linha removida');
    expect(removed.removal_count).toBe(1);
    // Eventos repetidos da mesma queda não contam duas vezes.
    await publishWaxumEvent(line.waxum_session_id, 'logged_out', { reason: 'LoggedOut', conflict: 'device_removed' });
    await delay(1500);
    expect((await byId()).removal_count).toBe(1);

    // Pareada de novo, a linha cai de novo: segunda queda aposenta e recusa QR novo.
    await billingPool.query('UPDATE whatsapp_numbers SET loss_reason = NULL WHERE id = $1', [line.id]);
    await publishWaxumEvent(line.waxum_session_id, 'account_locked', { reason: 'AccountLocked' });
    const locked = await waitFor(async () => { const item = await byId(); return item.loss_reason === 'account_locked' ? item : false; }, 'conta travada');
    expect(locked.removal_count).toBe(2);
    const qr = await api.get(`/api/tenants/${tenantA}/numbers/${line.id}/qr`, { headers: headers(leaderToken, tenantA) });
    expect(qr.ok()).toBeFalsy();
    expect(JSON.stringify(await qr.json())).toContain('aposentada');
    const events = (await billingPool.query("SELECT event_type FROM number_health_events WHERE number_id = $1 AND event_type IN ('device_removed', 'account_locked') ORDER BY occurred_at", [line.id])).rows.map((row) => row.event_type);
    expect(events).toEqual(['device_removed', 'account_locked']);
    await api.dispose();
  });

  test('17. sinais: as respostas a oferta e a queda logo depois ficam gravadas com os ms desde a oferta', async () => {
    const call = (await billingPool.query('SELECT c.waxum_call_id, n.waxum_session_id FROM calls c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE c.id = $1', [canaryCallId])).rows[0];
    await publishWaxumEvent(call.waxum_session_id, 'incoming_call', { call_id: call.waxum_call_id, action: `PreAccept { call_id: "${call.waxum_call_id}" }`, from: '10000000000000@lid' });
    const signal = await waitFor(async () => (await billingPool.query('SELECT call_id, kind, ms_since_offer FROM call_signal_events WHERE waxum_call_id = $1', [call.waxum_call_id])).rows[0] ?? false, 'sinal gravado');
    expect(signal.call_id).toBe(canaryCallId);
    expect(signal.kind).toBe('call_preaccept');
    expect(signal.ms_since_offer).toBeGreaterThan(0);
    // Os logouts da jornada 16 também ficaram gravados, sem ligação (nenhuma oferta recente).
    const losses = (await billingPool.query("SELECT kind, call_id FROM call_signal_events WHERE kind IN ('logged_out', 'account_locked')")).rows;
    expect(losses.length).toBeGreaterThanOrEqual(3);
  });

  test('18. limite diario: linha pareada ha poucos dias para em 60 ligacoes no dia', async () => {
    const api = await context();
    await billingPool.query('UPDATE whatsapp_numbers SET last_paired_at = now() WHERE id = $1', [numberId]);
    const copies = await billingPool.query(`
      INSERT INTO calls SELECT (jsonb_populate_record(c, jsonb_build_object('id', 'e2e-cap-' || g || '-' || c.id, 'status', 'completed', 'created_at', now(), 'canary', false))).*
      FROM calls c, generate_series(1, 60) g WHERE c.id = $1 RETURNING id
    `, [canaryCallId]);
    expect(copies.rowCount).toBe(60);
    // A lista de números fica 1,5 s em cache: espera o dado novo.
    const listed = await waitFor(async () => {
      const item = (await expectOk(await api.get(`/api/tenants/${tenantA}/numbers`, { headers: headers(leaderToken, tenantA) }))).items.find((row: any) => row.id === numberId);
      return item.young ? item : false;
    }, 'linha jovem na lista');
    expect(listed.calls_today).toBeGreaterThanOrEqual(60);
    await openStation(api);
    const capped = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(sdrToken, tenantA), data: { phone: '5511988885555', numberId } });
    expect(capped.ok()).toBeFalsy();
    expect(JSON.stringify(await capped.json())).toContain('limite de ligações de hoje');
    control.close();
    await billingPool.query("DELETE FROM calls WHERE id LIKE 'e2e-cap-%'");
    await billingPool.query('UPDATE whatsapp_numbers SET last_paired_at = NULL WHERE id = $1', [numberId]);
    await api.dispose();
  });

  test('19. causa da queda: banimento temporario segura a linha ate o prazo e fica registrado', async () => {
    const api = await context();
    const sessionId = (await billingPool.query('SELECT waxum_session_id FROM whatsapp_numbers WHERE id = $1', [numberId])).rows[0].waxum_session_id;
    await publishWaxumEvent(sessionId, 'temp_banned', { code: 101, expire_secs: 600 });
    const held = await waitFor(async () => {
      const row = (await billingPool.query('SELECT dial_blocked_until, dial_block_cause FROM whatsapp_numbers WHERE id = $1', [numberId])).rows[0];
      return row.dial_block_cause === 'temp_banned' ? row : false;
    }, 'linha segura pelo banimento');
    expect(new Date(held.dial_blocked_until).getTime()).toBeGreaterThan(Date.now() + 500_000);
    const events = (await billingPool.query("SELECT cause, code FROM line_loss_events WHERE number_id = $1 AND cause = 'temp_banned'", [numberId])).rows;
    expect(events).toEqual([{ cause: 'temp_banned', code: '101' }]);
    await openStation(api);
    const refused = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(sdrToken, tenantA), data: { phone: '5511988885555', numberId } });
    expect(refused.ok()).toBeFalsy();
    expect(JSON.stringify(await refused.json())).toContain('pausada');
    control.close();
    await billingPool.query('UPDATE whatsapp_numbers SET dial_blocked_until = NULL, dial_block_cause = NULL WHERE id = $1', [numberId]);
    await api.dispose();
  });
});
