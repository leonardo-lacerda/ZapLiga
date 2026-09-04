import { expect, request as playwrightRequest, test } from '@playwright/test';
import WebSocket from 'ws';

const apiBase = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
const wsBase = apiBase.replace(/^http/, 'ws');
const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const initialPassword = 'Launch!23456';
const changedPassword = 'Changed!23456';

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

async function context() { return playwrightRequest.newContext({ baseURL: apiBase }); }
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

test.describe.serial('Gate B - jornadas criticas', () => {
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
    await page.goto('/login');
    await page.getByPlaceholder('voce@empresa.com').fill(leaderEmail);
    await page.getByPlaceholder('Digite sua senha').fill(initialPassword);
    await page.getByRole('button', { name: 'Entrar na central' }).click();
    await expect(page).toHaveURL(/\/app\/?/);
    const api = await context();
    leaderToken = (await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: initialPassword } }))).accessToken;
    adminToken = (await expectOk(await api.post('/api/auth/login', { data: { email: 'admin@zapcall.local', password: 'ZapCall-Smoke-2026!' } }))).accessToken;
    const roadmapFeatures = ['campaigns', 'decision_engine', 'recommendations', 'operation_health', 'analytics_learning', 'experiments', 'benchmarks'];
    const initialFlags = await expectOk(await api.get(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA) }));
    for (const feature of roadmapFeatures) expect(initialFlags[feature], `${feature} deve nascer desativada`).toBe(false);
    await expectOk(await api.patch(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA), data: { schedule_enforcement: true, callbacks: true, privacy_requests: true, onboarding: true } }));
    const updatedFlags = await expectOk(await api.get(`/api/tenants/${tenantA}/feature-flags`, { headers: headers(adminToken, tenantA) }));
    for (const feature of roadmapFeatures) expect(updatedFlags[feature], `${feature} nao deve ser ativada por outra flag`).toBe(false);
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
    const api = await context();
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

  test('5. conexao de numero usa o fake deterministico e le estado', async () => {
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
    await api.dispose();
  });

  test('6. importacao preserva supressao depois de excluir e reimportar', async () => {
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

  test('7. discagem e bloqueada fora do horario', async () => {
    const api = await context();
    await expectOk(await api.put(`/api/tenants/${tenantA}/dialer/schedule`, { headers: headers(leaderToken, tenantA), data: { timezone: 'America/Sao_Paulo', windows: [], exceptions: [] } }));
    const blocked = await api.post(`/api/tenants/${tenantA}/calls/manual`, { headers: headers(leaderToken, tenantA), data: { phone: '5511988887777', name: 'Bloqueado' } });
    expect(blocked.status()).toBe(400);
    await expectOk(await api.put(`/api/tenants/${tenantA}/dialer/schedule`, { headers: headers(leaderToken, tenantA), data: { timezone: 'America/Sao_Paulo', windows: Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, start_time: '00:00', end_time: '23:59' })), exceptions: [] } }));
    await api.dispose();
  });

  test('8. voz chega ao SDR sem depender do evento Accept e abre pos-atendimento', async () => {
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

  test('9. callback vence, e reatribuido e concluido por nova chamada', async () => {
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

  test('10. exportacao e anonimizacao LGPD sao autenticadas e idempotentes', async () => {
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

  test('11. revogacao de sessao invalida access token no request seguinte', async () => {
    const api = await context();
    const first = await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: changedPassword } }));
    const second = await expectOk(await api.post('/api/auth/login', { data: { email: leaderEmail, password: changedPassword } }));
    const sessions = await expectOk(await api.get('/api/me/sessions', { headers: headers(first.accessToken) }));
    const target = sessions.find((item: any) => !item.current);
    await expectOk(await api.delete(`/api/me/sessions/${target.id}`, { headers: headers(first.accessToken) }));
    expect((await api.get('/api/auth/me', { headers: headers(second.accessToken) })).status()).toBe(401);
    await api.dispose();
  });

  test('12. todas as novas rotas preservam isolamento multitenant', async () => {
    const api = await context();
    const paths = ['dialer/schedule', 'callbacks', 'privacy/requests', 'feature-flags', 'onboarding', 'contact-suppressions'];
    for (const path of paths) {
      const response = await api.get(`/api/tenants/${tenantA}/${path}`, { headers: headers(ownerBToken, tenantA) });
      expect(response.status(), path).toBe(401);
    }
    control?.close();
    await api.dispose();
  });
});
