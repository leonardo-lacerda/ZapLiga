import { BadRequestException, HttpStatus } from '@nestjs/common';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GeelarkWorkerError, WorkerJob } from '../../infrastructure/geelark-worker/geelark-worker.client';
import { WhatsappProvisioningService } from './whatsapp-provisioning.service';

const TENANT = 'tenant-1';
const USER = 'leader-1';
const SMS_CODE = '482913';
const PAIR_CODE = 'KX7P-2QMZ';
const PC_ID = 'a55241de-0000-4000-8000-000000000001';
const OTHER_PC_ID = 'b7c1e2f3-0000-4000-8000-000000000002';
const SOCKS_ENV = {
  EGRESS_SOCKS_PUBLIC_HOST: '209.50.229.249',
  EGRESS_SOCKS_PORT: '1080',
  EGRESS_SOCKS_PASSWORD: 'gateway-secret',
  EGRESS_SOCKS_INTERNAL_URL: 'socks-gateway:1080',
};

const workerJob = (overrides: Partial<WorkerJob> = {}): WorkerJob => ({
  jobId: 'job-1', phoneId: 'phone-1', app: 'whatsapp', number: '5511987654321',
  status: 'running', step: 'queued', awaiting: null, message: null, errorCode: null, hasScreenshot: false,
  egressIp: null, history: [{ step: 'queued', at: '2026-11-17T10:00:00Z', message: null }],
  createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:00:00Z',
  ...overrides,
});

type Pc = { id: string; name: string; slot: string; online: boolean };

/** In-memory stand-in for the tables the service touches. */
const makeDb = () => {
  const jobs = new Map<string, any>();
  const numbers = new Map<string, any>();
  const assignments = new Map<string, string>();
  const users = new Map<string, string>([['user-ana', 'Ana'], [USER, 'Líder']]);
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO provisioning_jobs')) {
      const [id, tenant_id, created_by, egress_node, geelark_phone_id, phone_name, mode, app, phone, power_off_when_done] = params;
      const row = { id, tenant_id, created_by, egress_node, geelark_phone_id, phone_name, mode, app, phone, status: 'running', step: 'queued', awaiting: null, message: null, error_code: null, egress_ip: null, has_screenshot: false, history: [], linked: false, number_id: null, link_started_at: null, power_off_when_done, created_at: new Date(), updated_at: new Date(), finished_at: null };
      jobs.set(id, row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('SELECT * FROM provisioning_jobs WHERE id')) {
      const row = jobs.get(params[0]);
      return { rows: row && row.tenant_id === params[1] ? [{ ...row }] : [] };
    }
    if (text.startsWith('SELECT * FROM provisioning_jobs WHERE finished_at IS NULL')) {
      const idleBefore = Date.now() - params[0] * 1000;
      return { rows: [...jobs.values()].filter((row) => !row.finished_at && new Date(row.updated_at).getTime() < idleBefore).slice(0, params[1]).map((row) => ({ ...row })) };
    }
    if (text.startsWith('SELECT * FROM provisioning_jobs WHERE tenant_id')) return { rows: [...jobs.values()].filter((row) => row.tenant_id === params[0]) };
    if (text.startsWith('UPDATE provisioning_jobs SET status = $3, step = $4')) {
      const row = jobs.get(params[0]);
      if (!row || row.tenant_id !== params[1] || row.finished_at) return { rows: [] };
      Object.assign(row, { status: params[2], step: params[3], awaiting: params[4], message: params[5], error_code: params[6], egress_ip: params[7], has_screenshot: params[8], history: JSON.parse(params[9]), updated_at: new Date() });
      if (params[10]) row.link_started_at ??= new Date();
      row.finished_at = params[11] ? new Date() : null;
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('UPDATE provisioning_jobs SET status = $3, awaiting = NULL')) {
      const row = jobs.get(params[0]);
      if (!row || row.tenant_id !== params[1] || row.finished_at) return { rows: [] };
      Object.assign(row, { status: params[2], awaiting: null, error_code: params[3], message: params[4], linked: row.linked || params[5], finished_at: new Date(), updated_at: new Date() });
      if (params[2] === 'done') row.step = 'done';
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('UPDATE provisioning_jobs SET message')) {
      const row = jobs.get(params[0]);
      if (!row || row.tenant_id !== params[1]) return { rows: [] };
      row.message = params[2];
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('UPDATE provisioning_jobs SET number_id')) {
      const row = jobs.get(params[0]);
      row.number_id = params[2];
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('DELETE FROM provisioning_jobs')) { jobs.delete(params[0]); return { rows: [] }; }
    if (text.startsWith('SELECT id, waxum_session_id')) {
      const row = numbers.get(params[0]);
      return { rows: row && row.tenant_id === params[1] ? [row] : [] };
    }
    if (text.startsWith('UPDATE whatsapp_numbers')) { const row = numbers.get(params[0]); if (row) Object.assign(row, { status: 'connected', warmup_hours: params[3] }); return { rows: [] }; }
    if (text.startsWith('SELECT n.node_name')) {
      return { rows: [...assignments.entries()].filter(([key]) => key.startsWith(`${params[0]}|`)).map(([key, userId]) => ({ node_name: key.split('|')[1], user_id: userId, user_name: users.get(userId) ?? null })) };
    }
    if (text.startsWith('SELECT u.id, u.name FROM users')) return { rows: users.has(params[1]) ? [{ id: params[1], name: users.get(params[1]) }] : [] };
    if (text.startsWith('INSERT INTO provisioning_egress_nodes')) { assignments.set(`${params[0]}|${params[1]}`, params[2]); return { rows: [] }; }
    if (text.startsWith('DELETE FROM provisioning_egress_nodes')) { assignments.delete(`${params[0]}|${params[1]}`); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${text.slice(0, 80)}`);
  });
  return { query, jobs, numbers, assignments };
};

const makeService = (options: { tailscaleConnected?: boolean; pcs?: Pc[] } = {}) => {
  const db = makeDb();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const entitlement = { assertAction: jest.fn().mockResolvedValue(undefined) };
  const redis = { client: { set: jest.fn().mockResolvedValue('OK') }, acquireLock: jest.fn().mockResolvedValue(true), releaseLock: jest.fn().mockResolvedValue(undefined) };
  const worker = {
    listPhones: jest.fn().mockResolvedValue([{ id: 'phone-1', name: 'Phone 2', status: 'off', android: 'Android 12', proxy: null, apps: { whatsapp: false, business: false }, busyJobId: null }]),
    createJob: jest.fn(async (job: any) => workerJob({ jobId: job.jobId })),
    getJob: jest.fn(),
    sendInput: jest.fn(),
    cancelJob: jest.fn().mockResolvedValue(workerJob({ status: 'cancelled', step: 'cancelled' })),
    stopPhone: jest.fn().mockResolvedValue({ ok: true }),
    screenshot: jest.fn(),
    liveScreen: jest.fn(),
    manualAction: jest.fn().mockResolvedValue({ ok: true }),
    takeOver: jest.fn(),
    renamePhone: jest.fn().mockResolvedValue({ ok: true }),
    newDevice: jest.fn().mockResolvedValue({ ok: true }),
    deletePhone: jest.fn().mockResolvedValue({ ok: true }),
  };
  const pcs: Pc[] = options.pcs ?? [
    { id: PC_ID, name: 'PC da Ana', slot: 'edge-1', online: true },
    { id: OTHER_PC_ID, name: 'PC do Bruno', slot: 'edge-2', online: false },
  ];
  const egress = {
    settings: jest.fn(async () => ({ configured: options.tailscaleConnected ?? true })),
    pcExits: jest.fn(async (id?: string) => pcs.filter((pc) => !id || pc.id === id).map((pc) => ({ ...pc }))),
  };
  const numbers = {
    create: jest.fn(async (tenantId: string, _actor: string | null, _body: unknown, node: string) => {
      const line = { id: 'number-1', tenant_id: tenantId, waxum_session_id: 'session-1', waxum_node: node };
      db.numbers.set(line.id, line);
      return line;
    }),
    pairCode: jest.fn().mockResolvedValue({ code: PAIR_CODE, timeout_seconds: 60 }),
  };
  const waxum = {
    reconnect: jest.fn().mockResolvedValue({}),
    getStatus: jest.fn().mockResolvedValue({ status: 'connecting', is_logged_in: false }),
  };
  const service = new WhatsappProvisioningService(db as any, audit as any, entitlement as any, redis as any, worker as any, egress as any, numbers as any, waxum as any);
  service.timing = { pollIntervalMs: 1, pairCodeWaitMs: 200, linkTimeoutMs: 120_000 };
  return { service, db, audit, entitlement, redis, worker, egress, pcs, numbers, waxum };
};

const createInput = { egressNode: PC_ID, geelarkPhoneId: 'phone-1', app: 'whatsapp' as const, countryCode: '+55', number: '(11) 98765-4321' };

const startJob = async (ctx: ReturnType<typeof makeService>, input: Partial<typeof createInput> & { powerOffWhenDone?: boolean } = {}) => {
  const job = await ctx.service.createJob(TENANT, USER, { ...createInput, ...input });
  return job.id;
};

const actions = (audit: { record: jest.Mock }) => audit.record.mock.calls.map(([entry]) => entry.action);

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [key, value] of Object.entries(SOCKS_ENV)) { savedEnv[key] = process.env[key]; process.env[key] = value; }
});
afterEach(() => {
  for (const key of Object.keys(SOCKS_ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

describe('WhatsappProvisioningService — egress (attendant PCs)', () => {
  it('lists the PCs with a slot: node = PC id, label = PC name or the linked person, no public IPs', async () => {
    const ctx = makeService();
    ctx.db.assignments.set(`${TENANT}|${OTHER_PC_ID}`, USER);

    const result = await ctx.service.listEgress(TENANT, USER);

    expect(result.configured).toBe(true);
    expect(result.items).toEqual([
      { node: OTHER_PC_ID, label: 'Líder', pcName: 'PC do Bruno', online: false, publicIps: [], userId: USER, userName: 'Líder', isMine: true },
      { node: PC_ID, label: 'PC da Ana', pcName: 'PC da Ana', online: true, publicIps: [], userId: null, userName: null, isMine: false },
    ]);
    expect(ctx.egress.pcExits).toHaveBeenCalledWith();
  });

  it.each([
    ['Tailscale is not connected', { tailscale: false, env: {} }],
    ['the public host is missing', { tailscale: true, env: { EGRESS_SOCKS_PUBLIC_HOST: '' } }],
    ['the gateway password is missing', { tailscale: true, env: { EGRESS_SOCKS_PASSWORD: '' } }],
  ])('is not configured when %s: empty list and POST jobs answers 503', async (_case, { tailscale, env }) => {
    Object.assign(process.env, env);
    const ctx = makeService({ tailscaleConnected: tailscale });

    expect(await ctx.service.listEgress(TENANT, USER)).toEqual({ items: [], configured: false });
    await expect(ctx.service.createJob(TENANT, USER, createInput)).rejects.toMatchObject({ status: 503, response: expect.objectContaining({ code: 'egress_not_configured', message: expect.stringContaining('PCs dos atendentes') }) });
    expect(ctx.worker.createJob).not.toHaveBeenCalled();
  });

  it('links a PC to a person by PC id and validates that the PC exists', async () => {
    const ctx = makeService();

    const node = await ctx.service.assignEgress(TENANT, USER, PC_ID, 'user-ana');

    expect(node).toMatchObject({ node: PC_ID, label: 'Ana', pcName: 'PC da Ana', userId: 'user-ana', isMine: false });
    expect(ctx.db.assignments.get(`${TENANT}|${PC_ID}`)).toBe('user-ana');
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.egress_assigned', entityId: PC_ID, metadata: { userId: 'user-ana' } }));

    await ctx.service.assignEgress(TENANT, USER, PC_ID, null);
    expect(ctx.db.assignments.has(`${TENANT}|${PC_ID}`)).toBe(false);

    await expect(ctx.service.assignEgress(TENANT, USER, 'c0ffee00-0000-4000-8000-000000000009', 'user-ana')).rejects.toMatchObject({ status: 404 });
    await expect(ctx.service.assignEgress(TENANT, USER, '../etc', 'user-ana')).rejects.toMatchObject({ status: 400 });
    await expect(ctx.service.assignEgress(TENANT, USER, PC_ID, 'stranger')).rejects.toMatchObject({ status: 400 });
  });
});

describe('WhatsappProvisioningService — phones created from ZapLiga', () => {
  const newPhone = { id: 'phone-9', name: 'WhatsApp 3', status: 'off', android: 'Android 12', proxy: 'socks5 209.50.229.249:1080', apps: { whatsapp: null, business: null }, busyJobId: null };

  it('creates the phone already behind the chosen PC, through the public SOCKS gateway', async () => {
    const ctx = makeService();
    (ctx.worker as any).createPhone = jest.fn().mockResolvedValue(newPhone);

    const phone = await ctx.service.createPhone(TENANT, USER, { name: '  WhatsApp 3 ', androidVersion: 'Android 12', egressNode: PC_ID });

    expect(phone).toEqual(newPhone);
    expect(ctx.entitlement.assertAction).toHaveBeenCalledWith(TENANT, 'write', USER);
    expect((ctx.worker as any).createPhone).toHaveBeenCalledWith({
      name: 'WhatsApp 3', androidVersion: 'Android 12',
      proxy: { typeId: 1, server: '209.50.229.249', port: 1080, username: 'edge-1', password: 'gateway-secret' },
    });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.phone_created', entityId: 'phone-9', metadata: { androidVersion: 'Android 12', egressNode: PC_ID, slot: 'edge-1' } }));
    expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain('gateway-secret');
  });

  it('powers a phone off from ZapLiga and audits it', async () => {
    const ctx = makeService();
    ctx.worker.listPhones.mockResolvedValue([{ id: 'phone-1', name: 'Phone 2', status: 'on', android: 'Android 12', proxy: null, apps: { whatsapp: true, business: false }, busyJobId: 'job-7' }]);

    const phone = await ctx.service.powerOffPhone(TENANT, USER, 'phone-1');

    expect(phone).toMatchObject({ id: 'phone-1', status: 'off', busyJobId: null });
    expect(ctx.entitlement.assertAction).toHaveBeenCalledWith(TENANT, 'write', USER);
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.phone_stopped', entityId: 'phone-1', metadata: { previousStatus: 'on', cancelledJob: 'job-7' } }));
    await expect(ctx.service.powerOffPhone(TENANT, USER, 'phone-x')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an offline PC, an empty name or Android 10 before calling GeeLark', async () => {
    const ctx = makeService();
    (ctx.worker as any).createPhone = jest.fn();

    await expect(ctx.service.createPhone(TENANT, USER, { name: 'X', androidVersion: 'Android 12', egressNode: OTHER_PC_ID })).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'egress_offline' }) });
    await expect(ctx.service.createPhone(TENANT, USER, { name: '  ', androidVersion: 'Android 12', egressNode: PC_ID })).rejects.toMatchObject({ status: 400 });
    await expect(ctx.service.createPhone(TENANT, USER, { name: 'X', androidVersion: 'Android 10' as any, egressNode: PC_ID })).rejects.toMatchObject({ status: 400 });
    expect((ctx.worker as any).createPhone).not.toHaveBeenCalled();
  });

  it('tests the internet of a phone: no app nor number, always powers off, ends in network_ok', async () => {
    const ctx = makeService();

    const job = await ctx.service.createJob(TENANT, USER, { egressNode: PC_ID, geelarkPhoneId: 'phone-1', mode: 'network_check', powerOffWhenDone: false });

    expect(ctx.worker.createJob).toHaveBeenCalledWith({
      jobId: job.id, phoneId: 'phone-1', mode: 'network_check',
      proxy: { typeId: 1, server: '209.50.229.249', port: 1080, username: 'edge-1', password: 'gateway-secret' },
      probeProxy: { server: 'socks-gateway', port: 1080, username: 'edge-1', password: 'gateway-secret' },
      expectedEgressIps: [], powerOffWhenDone: true,
    });
    expect(job).toMatchObject({ mode: 'network_check', app: null, number: null });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.started', metadata: expect.objectContaining({ mode: 'network_check', app: null }) }));

    ctx.worker.getJob.mockResolvedValue(workerJob({ jobId: job.id, app: null, number: null, status: 'done', step: 'network_ok', egressIp: '131.255.254.90', message: 'Internet ok: o phone sai pelo IP 131.255.254.90, o mesmo do PC escolhido.' }));
    const done = await ctx.service.getJob(TENANT, USER, job.id);
    expect(done).toMatchObject({ status: 'done', step: 'network_ok', egressIp: '131.255.254.90', finishedAt: expect.any(String) });
    // Nothing to link: the link decision is refused instead of creating a line without a number.
    await expect(ctx.service.decideLink(TENANT, USER, job.id, true)).rejects.toMatchObject({ status: 409 });
    expect(ctx.numbers.create).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvisioningService — job creation', () => {
  it('starts a job through the PC slot resolved now, with the public proxy and the internal probe proxy', async () => {
    const ctx = makeService();
    const job = await ctx.service.createJob(TENANT, USER, createInput);

    expect(ctx.entitlement.assertAction).toHaveBeenCalledWith(TENANT, 'write', USER);
    expect(ctx.egress.pcExits).toHaveBeenCalledWith(PC_ID);
    expect(ctx.worker.createJob).toHaveBeenCalledWith({
      jobId: job.id, phoneId: 'phone-1', mode: 'register', app: 'whatsapp', countryCode: '55', number: '11987654321', resetApp: false,
      proxy: { typeId: 1, server: '209.50.229.249', port: 1080, username: 'edge-1', password: 'gateway-secret' },
      probeProxy: { server: 'socks-gateway', port: 1080, username: 'edge-1', password: 'gateway-secret' },
      expectedEgressIps: [], powerOffWhenDone: true,
    });
    expect(job).toMatchObject({ mode: 'register', status: 'running', step: 'queued', number: '5511987654321', phoneName: 'Phone 2', egressNode: PC_ID, linked: false, numberId: null, createdBy: USER });
    expect(ctx.db.jobs.get(job.id).egress_node).toBe(PC_ID);
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.started', metadata: { mode: 'register', app: 'whatsapp', egressNode: PC_ID, slot: 'edge-1', geelarkPhoneId: 'phone-1' } }));
    expect(actions(ctx.audit)).toEqual(['provisioning.started']);
    // The gateway password goes to the worker only, never to the job copy or the audit trail.
    expect(JSON.stringify([...ctx.db.jobs.values()])).not.toContain('gateway-secret');
    expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain('gateway-secret');
  });

  it('passes "wipe the WhatsApp on this phone" to the worker and audits it', async () => {
    const ctx = makeService();
    await ctx.service.createJob(TENANT, USER, { ...createInput, resetApp: true });
    expect(ctx.worker.createJob).toHaveBeenCalledWith(expect.objectContaining({ resetApp: true }));
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.started', metadata: expect.objectContaining({ resetApp: true }) }));
  });

  it('uses the configured public port and internal address', async () => {
    process.env.EGRESS_SOCKS_PORT = '21080';
    process.env.EGRESS_SOCKS_INTERNAL_URL = 'socks5://gw.internal:1090';
    const ctx = makeService({ pcs: [{ id: PC_ID, name: 'PC da Ana', slot: 'edge-3', online: true }] });

    await ctx.service.createJob(TENANT, USER, createInput);

    expect(ctx.worker.createJob).toHaveBeenCalledWith(expect.objectContaining({
      proxy: expect.objectContaining({ port: 21080, username: 'edge-3' }),
      probeProxy: { server: 'gw.internal', port: 1090, username: 'edge-3', password: 'gateway-secret' },
    }));
  });

  it('refuses an offline PC with 409 egress_offline', async () => {
    const ctx = makeService();
    await expect(ctx.service.createJob(TENANT, USER, { ...createInput, egressNode: OTHER_PC_ID })).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: 'egress_offline' }) });
    expect(ctx.worker.createJob).not.toHaveBeenCalled();
  });

  it('refuses an unknown PC (or one without a slot) as offline too', async () => {
    const ctx = makeService();
    await expect(ctx.service.createJob(TENANT, USER, { ...createInput, egressNode: 'c0ffee00-0000-4000-8000-000000000009' })).rejects.toMatchObject({ status: 409 });
    await expect(ctx.service.createJob(TENANT, USER, { ...createInput, egressNode: 'zapliga pc' })).rejects.toMatchObject({ status: 409 });
    expect(ctx.worker.createJob).not.toHaveBeenCalled();
  });

  it('answers 400 for non-digit or out-of-range numbers', async () => {
    const ctx = makeService();
    for (const bad of [{ countryCode: '55', number: '11abc87654' }, { countryCode: 'BR', number: '11987654321' }, { countryCode: '055', number: '11987654321' }, { countryCode: '55', number: '123' }, { countryCode: '55', number: '1198765432112345' }]) {
      await expect(ctx.service.createJob(TENANT, USER, { ...createInput, ...bad })).rejects.toMatchObject({ status: 400 });
    }
    expect(ctx.worker.createJob).not.toHaveBeenCalled();
  });

  it('drops the copy when the worker refuses the job', async () => {
    const ctx = makeService();
    ctx.worker.createJob.mockRejectedValue(new GeelarkWorkerError('phone_busy', 'Este telefone já está em outro cadastro.', 409));
    await expect(ctx.service.createJob(TENANT, USER, createInput)).rejects.toMatchObject({ status: 409 });
    expect(ctx.db.jobs.size).toBe(0);
    expect(actions(ctx.audit)).toEqual([]);
  });
});

describe('WhatsappProvisioningService — sync', () => {
  it('persists the worker snapshot on GET and audits registration once', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.getJob.mockResolvedValue(workerJob({ jobId: id, status: 'waiting_input', step: 'registered', awaiting: 'link_decision', egressIp: '189.40.10.20' }));

    const job = await ctx.service.getJob(TENANT, USER, id);
    await ctx.service.getJob(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'waiting_input', step: 'registered', awaiting: 'link_decision', egressIp: '189.40.10.20' });
    expect(ctx.db.jobs.get(id)).toMatchObject({ step: 'registered', awaiting: 'link_decision' });
    expect(actions(ctx.audit).filter((action) => action === 'provisioning.registered')).toHaveLength(1);
  });

  it('marks an unfinished job the worker forgot as failed/worker_lost and stops the phone', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.getJob.mockResolvedValue(null);

    const job = await ctx.service.getJob(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'failed', errorCode: 'worker_lost', awaiting: null });
    expect(job.finishedAt).not.toBeNull();
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.failed', metadata: expect.objectContaining({ errorCode: 'worker_lost' }) }));

    ctx.worker.getJob.mockClear();
    await ctx.service.getJob(TENANT, USER, id);
    expect(ctx.worker.getJob).not.toHaveBeenCalled();
  });

  it('never reads a job of another tenant', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    await expect(ctx.service.getJob('tenant-2', USER, id)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(ctx.worker.getJob).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvisioningService — SMS code', () => {
  it('forwards the code to the worker but never persists or audits it', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'running', step: 'verifying', history: [{ step: 'verifying', at: '2026-11-17T10:01:00Z', message: 'Verificando código' }] }));

    const job = await ctx.service.submitSms(TENANT, USER, id, '482-913');

    expect(job.step).toBe('verifying');
    expect(ctx.worker.sendInput).toHaveBeenCalledWith(id, { type: 'sms', code: SMS_CODE });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.sms_submitted' }));
    expect(JSON.stringify(ctx.db.query.mock.calls)).not.toContain(SMS_CODE);
    expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(SMS_CODE);
    expect(JSON.stringify([...ctx.db.jobs.values()])).not.toContain(SMS_CODE);
  });

  it('rejects codes that are not 6 digits before calling the worker', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    await expect(ctx.service.submitSms(TENANT, USER, id, '12345')).rejects.toMatchObject({ status: 400 });
    expect(ctx.worker.sendInput).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvisioningService — profile', () => {
  it('sends the name and a PNG photo as base64', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, step: 'saving_profile' }));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);

    await ctx.service.submitProfile(TENANT, USER, id, ' Ana ', { buffer: png, size: png.length, mimetype: 'image/png' });

    expect(ctx.worker.sendInput).toHaveBeenCalledWith(id, { type: 'profile', name: 'Ana', photoBase64: png.toString('base64'), photoMime: 'image/png' });
  });

  it('rejects photos that are not JPEG/PNG or exceed 2 MB', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    const gif = Buffer.from('GIF89a....');
    await expect(ctx.service.submitProfile(TENANT, USER, id, 'Ana', { buffer: gif, size: gif.length, mimetype: 'image/png' })).rejects.toMatchObject({ status: 400 });
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0xff);
    await expect(ctx.service.submitProfile(TENANT, USER, id, 'Ana', { buffer: big, size: big.length })).rejects.toMatchObject({ status: 400 });
    expect(ctx.worker.sendInput).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvisioningService — SMS help (live screen, resend, call)', () => {
  it('asks the worker for another code only while waiting for the SMS, and audits the method', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.getJob.mockResolvedValueOnce(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms' }));
    await ctx.service.getJob(TENANT, USER, id);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_sms', awaiting: 'sms', message: 'Pedimos uma ligação com o código.' }));

    const job = await ctx.service.requestNewCode(TENANT, USER, id, 'voice');

    expect(ctx.worker.sendInput).toHaveBeenCalledWith(id, { type: 'call_me' });
    expect(job).toMatchObject({ awaiting: 'sms', message: 'Pedimos uma ligação com o código.' });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.code_requested', metadata: { method: 'voice' } }));
    await ctx.service.requestNewCode(TENANT, USER, id, 'sms');
    expect(ctx.worker.sendInput).toHaveBeenLastCalledWith(id, { type: 'resend_sms' });
  });

  it('refuses another code outside the SMS wait', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    await expect(ctx.service.requestNewCode(TENANT, USER, id, 'sms')).rejects.toMatchObject({ status: 409 });
    expect(ctx.worker.sendInput).not.toHaveBeenCalled();
  });

  it('passes the operator touches to the worker and audits them without the text', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    expect(await ctx.service.manualAction(TENANT, USER, id, { type: 'key', key: 'back' })).toEqual({ ok: true });
    await ctx.service.manualAction(TENANT, USER, id, { type: 'text', text: '123456' });
    expect(ctx.worker.manualAction).toHaveBeenLastCalledWith(id, { type: 'text', text: '123456' });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.manual_action', metadata: { type: 'key', key: 'back' } }));
    expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain('123456');
    ctx.db.jobs.get(id).finished_at = new Date();
    await expect(ctx.service.manualAction(TENANT, USER, id, { type: 'tap', x: 0.5, y: 0.5 })).rejects.toMatchObject({ status: 409 });
  });

  it('asks the worker to stop the robot and audits the takeover', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.takeOver.mockResolvedValue(workerJob({ jobId: id, status: 'running', step: 'entering_number', message: 'Pausando o robô: ele para assim que chegar na próxima tela do WhatsApp.' }));
    const job = await ctx.service.takeOver(TENANT, USER, id);
    expect(ctx.worker.takeOver).toHaveBeenCalledWith(id);
    expect(job.message).toMatch(/Pausando o robô/);
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.manual_takeover' }));
  });

  it('hands the phone back to the robot only while it waits for the operator', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    await expect(ctx.service.resumeRobot(TENANT, USER, id)).rejects.toMatchObject({ status: 409 });
    ctx.worker.getJob.mockResolvedValueOnce(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_manual', awaiting: 'manual', message: 'Tela desconhecida.' }));
    expect(await ctx.service.getJob(TENANT, USER, id)).toMatchObject({ awaiting: 'manual', step: 'waiting_manual' });
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'running', step: 'entering_number' }));
    const job = await ctx.service.resumeRobot(TENANT, USER, id);
    expect(ctx.worker.sendInput).toHaveBeenCalledWith(id, { type: 'resume' });
    expect(job).toMatchObject({ status: 'running', awaiting: null });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.robot_resumed' }));
  });

  it('serves the live screen while the job runs and 404 once it is over', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.liveScreen.mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    expect(await ctx.service.liveScreen(TENANT, id)).toEqual(Buffer.from([137, 80, 78, 71]));
    ctx.db.jobs.get(id).finished_at = new Date();
    await expect(ctx.service.liveScreen(TENANT, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('WhatsappProvisioningService — link to ZapLiga', () => {
  const registeredJob = async (ctx: ReturnType<typeof makeService>, input: { powerOffWhenDone?: boolean } = {}) => {
    const id = await startJob(ctx, input);
    ctx.worker.getJob.mockResolvedValueOnce(workerJob({ jobId: id, status: 'waiting_input', step: 'registered', awaiting: 'link_decision' }));
    await ctx.service.getJob(TENANT, USER, id);
    return id;
  };

  /** Registered job -> pair code typed -> worker done -> API in step `linking`. */
  const linkingJob = async (ctx: ReturnType<typeof makeService>, input: { powerOffWhenDone?: boolean } = {}) => {
    const id = await registeredJob(ctx, input);
    ctx.worker.sendInput.mockImplementation(async (_jobId: string, body: any) => (body.type === 'link'
      ? workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' })
      : workerJob({ jobId: id, status: 'running', step: 'entering_pair_code' })));
    await ctx.service.decideLink(TENANT, USER, id, true);
    ctx.worker.getJob.mockResolvedValue(workerJob({ jobId: id, status: 'done', step: 'done' }));
    await ctx.service.getJob(TENANT, USER, id);
    expect(ctx.db.jobs.get(id).step).toBe('linking');
    return id;
  };

  const connect = (ctx: ReturnType<typeof makeService>) => ctx.waxum.getStatus.mockResolvedValue({ status: 'connected', is_logged_in: true, phone_number: '5511987654321' });

  it('opens the link screen, creates the line, pairs it with NumbersService.pairCode and finishes when Waxum connects', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.worker.sendInput.mockImplementation(async (_jobId: string, input: any) => (input.type === 'link'
      ? workerJob({ jobId: id, status: 'running', step: 'opening_link_screen' })
      : workerJob({ jobId: id, status: 'running', step: 'entering_pair_code' })));
    ctx.worker.getJob.mockResolvedValueOnce(workerJob({ jobId: id, status: 'running', step: 'opening_link_screen' }))
      .mockResolvedValueOnce(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' }));

    const afterLink = await ctx.service.decideLink(TENANT, USER, id, true);

    expect(ctx.worker.sendInput).toHaveBeenNthCalledWith(1, id, { type: 'link' });
    // The line is born on the job PC's Waxum: the device's first login already leaves through the PC.
    expect(ctx.numbers.create).toHaveBeenCalledWith(TENANT, USER, { label: 'Phone 2', phone: '5511987654321' }, 'edge-1');
    expect(ctx.numbers.pairCode).toHaveBeenCalledWith(TENANT, USER, 'number-1', '5511987654321');
    expect(ctx.worker.sendInput).toHaveBeenNthCalledWith(2, id, { type: 'pair_code', code: PAIR_CODE });
    expect(afterLink).toMatchObject({ step: 'entering_pair_code', numberId: 'number-1', linked: false });
    expect(ctx.redis.releaseLock).toHaveBeenCalled();

    // Worker done: the API takes over and follows the Waxum session.
    ctx.worker.getJob.mockResolvedValue(workerJob({ jobId: id, status: 'done', step: 'done' }));
    const linking = await ctx.service.getJob(TENANT, USER, id);
    expect(linking).toMatchObject({ status: 'running', step: 'linking', linked: false, finishedAt: null });
    // The primary phone must stay online until Waxum confirms the pairing.
    expect(ctx.worker.stopPhone).not.toHaveBeenCalled();

    connect(ctx);
    ctx.worker.getJob.mockClear();
    const linked = await ctx.service.getJob(TENANT, USER, id);
    expect(ctx.worker.getJob).not.toHaveBeenCalled();
    expect(linked).toMatchObject({ status: 'done', step: 'done', linked: true, numberId: 'number-1' });
    expect(linked.message).toContain('pelo PC do cadastro');
    expect(linked.message).toContain('72 h em aquecimento');
    expect(ctx.db.numbers.get('number-1')).toMatchObject({ status: 'connected', warmup_hours: 72 });
    expect(actions(ctx.audit)).toContain('provisioning.linked');
    // Then the API powers the phone off (powerOffWhenDone defaults to true).
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');

    // The pairing code is never stored or audited by this module.
    expect(JSON.stringify(ctx.db.query.mock.calls)).not.toContain(PAIR_CODE);
    expect(JSON.stringify(ctx.audit.record.mock.calls)).not.toContain(PAIR_CODE);

    // Later polls (the other API instance included) do not power off again.
    await ctx.service.getJob(TENANT, USER, id);
    expect(ctx.worker.stopPhone).toHaveBeenCalledTimes(1);
  });

  it('creates the line on the slot the PC holds when linking, not the one at creation', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.pcs[0].slot = 'edge-4';
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' }));

    await ctx.service.decideLink(TENANT, USER, id, true);

    expect(ctx.egress.pcExits).toHaveBeenLastCalledWith(PC_ID);
    expect(ctx.numbers.create).toHaveBeenCalledWith(TENANT, USER, expect.anything(), 'edge-4');
  });

  it('refuses to link through the VPS when the PC is offline or lost its slot', async () => {
    for (const lose of [(pcs: Pc[]) => { pcs[0].online = false; }, (pcs: Pc[]) => { pcs.splice(0, 1); }]) {
      const ctx = makeService();
      const id = await registeredJob(ctx);
      lose(ctx.pcs);
      ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' }));

      const job = await ctx.service.decideLink(TENANT, USER, id, true);

      expect(job).toMatchObject({ status: 'failed', errorCode: 'pair_failed', linked: false });
      expect(job.message).toContain('O PC do cadastro não está online');
      expect(ctx.numbers.create).not.toHaveBeenCalled();
      expect(ctx.numbers.pairCode).not.toHaveBeenCalled();
    }
  });

  it('retries the pair code once after /connect when Waxum answers 503 for a new session', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.worker.sendInput.mockImplementation(async (_jobId: string, input: any) => (input.type === 'link'
      ? workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' })
      : workerJob({ jobId: id, status: 'running', step: 'entering_pair_code' })));
    ctx.numbers.pairCode.mockRejectedValueOnce(Object.assign(new Error('not ready'), { statusCode: 503 }));

    const job = await ctx.service.decideLink(TENANT, USER, id, true);

    expect(ctx.waxum.reconnect).toHaveBeenCalledWith('session-1');
    expect(ctx.numbers.pairCode).toHaveBeenCalledTimes(2);
    expect(ctx.worker.sendInput).toHaveBeenLastCalledWith(id, { type: 'pair_code', code: PAIR_CODE });
    expect(job).toMatchObject({ step: 'entering_pair_code' });
  });

  it('fails with pair_failed when NumbersService refuses the pair code, keeping the line', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'waiting_input', step: 'waiting_pair_code', awaiting: 'pair_code' }));
    ctx.numbers.pairCode.mockRejectedValue(new BadRequestException('Este número já está conectado ao WhatsApp'));

    const job = await ctx.service.decideLink(TENANT, USER, id, true);

    expect(job).toMatchObject({ status: 'failed', errorCode: 'pair_failed', numberId: 'number-1' });
    expect(job.message).toContain('Este número já está conectado ao WhatsApp');
    expect(ctx.worker.cancelJob).toHaveBeenCalledWith(id);
    expect(ctx.worker.sendInput).not.toHaveBeenCalledWith(id, expect.objectContaining({ type: 'pair_code' }));
  });

  it('fails with link_timeout after 120 s in linking and keeps the line', async () => {
    const ctx = makeService();
    const id = await linkingJob(ctx);

    ctx.db.jobs.get(id).link_started_at = new Date(Date.now() - 121_000);
    const job = await ctx.service.getJob(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'failed', errorCode: 'link_timeout', step: 'linking', numberId: 'number-1', linked: false });
    expect(ctx.db.numbers.has('number-1')).toBe(true);
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.failed', metadata: expect.objectContaining({ errorCode: 'link_timeout' }) }));
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
  });

  it('powers the phone off after linking even when an old client asks to keep it on', async () => {
    const ctx = makeService();
    const id = await linkingJob(ctx, { powerOffWhenDone: false });
    expect(ctx.worker.createJob).toHaveBeenCalledWith(expect.objectContaining({ powerOffWhenDone: true }));
    connect(ctx);

    const job = await ctx.service.getJob(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'done', linked: true });
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
  });

  it('the sweep settles a linking job nobody is watching and powers the phone off', async () => {
    const ctx = makeService();
    const id = await linkingJob(ctx);
    ctx.worker.stopPhone.mockClear();
    // Tab closed: nobody polls. A job polled seconds ago is left to the panel.
    expect(await ctx.service.sweepOpenJobs()).toBe(0);
    ctx.db.jobs.get(id).updated_at = new Date(Date.now() - 60_000);
    connect(ctx);

    expect(await ctx.service.sweepOpenJobs()).toBe(1);

    expect(ctx.db.jobs.get(id)).toMatchObject({ status: 'done', linked: true });
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
  });

  it('the sweep powers off the phone of a job the worker lost, and only one API instance sweeps', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.db.jobs.get(id).updated_at = new Date(Date.now() - 60_000);
    ctx.worker.getJob.mockResolvedValue(null);

    await ctx.service.sweepOpenJobs();

    expect(ctx.db.jobs.get(id)).toMatchObject({ status: 'failed', error_code: 'worker_lost' });
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
    ctx.redis.acquireLock.mockResolvedValueOnce(false);
    expect(await ctx.service.sweepOpenJobs()).toBe(0);
  });

  it('gives up when the phone never reaches the pair-code screen and powers it off', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'running', step: 'opening_link_screen' }));
    ctx.worker.getJob.mockResolvedValue(workerJob({ jobId: id, status: 'running', step: 'opening_link_screen' }));

    const job = await ctx.service.decideLink(TENANT, USER, id, true);

    expect(job).toMatchObject({ status: 'failed', errorCode: 'pair_failed' });
    expect(ctx.worker.cancelJob).toHaveBeenCalledWith(id);
    expect(ctx.numbers.create).not.toHaveBeenCalled();
    expect(ctx.numbers.pairCode).not.toHaveBeenCalled();
  });

  it('connect=false only tells the worker to finish', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.worker.sendInput.mockResolvedValue(workerJob({ jobId: id, status: 'done', step: 'done' }));

    const job = await ctx.service.decideLink(TENANT, USER, id, false);

    expect(ctx.worker.sendInput).toHaveBeenCalledWith(id, { type: 'finish' });
    expect(job).toMatchObject({ status: 'done', step: 'done', linked: false, numberId: null });
    expect(ctx.numbers.create).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent link request', async () => {
    const ctx = makeService();
    const id = await registeredJob(ctx);
    ctx.redis.acquireLock.mockResolvedValue(false);
    await expect(ctx.service.decideLink(TENANT, USER, id, true)).rejects.toMatchObject({ status: 409 });
    expect(ctx.worker.sendInput).not.toHaveBeenCalled();
  });
});

describe('WhatsappProvisioningService — cancel', () => {
  it('cancels on the worker and records it', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.cancelJob.mockResolvedValue(workerJob({ jobId: id, status: 'cancelled', step: 'entering_number', errorCode: 'cancelled' }));

    const job = await ctx.service.cancel(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'cancelled' });
    expect(actions(ctx.audit)).toContain('provisioning.cancelled');
  });

  it('cancels locally and stops the phone when the worker lost the job', async () => {
    const ctx = makeService();
    const id = await startJob(ctx);
    ctx.worker.cancelJob.mockRejectedValue(new GeelarkWorkerError('not_found', 'x', 404));

    const job = await ctx.service.cancel(TENANT, USER, id);

    expect(job).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    expect(ctx.worker.stopPhone).toHaveBeenCalledWith('phone-1');
  });
});

describe('whatsapp_provisioning migration', () => {
  const dir = join(__dirname, '../../database/migrations');

  it('runs after the call recordings and the egress PCs (064-066) and owns 067 alone', () => {
    const files = readdirSync(dir);
    for (const prefix of ['064_', '065_', '066_']) expect(files.some((file) => file.startsWith(prefix))).toBe(true);
    expect(existsSync(join(dir, '067_whatsapp_provisioning.sql'))).toBe(true);
    expect(files.filter((file) => file.startsWith('067_'))).toEqual(['067_whatsapp_provisioning.sql']);
    expect(files.filter((file) => file.includes('whatsapp_provisioning'))).toEqual(['067_whatsapp_provisioning.sql']);
  });
});


describe('WhatsappProvisioningService phone management', () => {
  it('renames a phone and audits from/to', async () => {
    const ctx = makeService();
    const phone = await ctx.service.renamePhone(TENANT, USER, 'phone-1', '  WhatsApp 4  ');
    expect(phone.name).toBe('WhatsApp 4');
    expect(ctx.worker.renamePhone).toHaveBeenCalledWith('phone-1', 'WhatsApp 4');
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.phone_renamed', metadata: { from: 'Phone 2', to: 'WhatsApp 4' } }));
    await expect(ctx.service.renamePhone(TENANT, USER, 'phone-1', '   ')).rejects.toMatchObject({ response: { code: 'invalid_name' } });
  });

  it('gives a phone a new device and forgets which apps it had', async () => {
    const ctx = makeService();
    const phone = await ctx.service.newDevice(TENANT, USER, 'phone-1');
    expect(ctx.worker.newDevice).toHaveBeenCalledWith('phone-1');
    expect(phone).toMatchObject({ status: 'off', apps: { whatsapp: null, business: null } });
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.phone_new_device' }));
  });

  it('deletes a phone and refuses an unknown one', async () => {
    const ctx = makeService();
    expect(await ctx.service.deletePhone(TENANT, USER, 'phone-1')).toEqual({ ok: true });
    expect(ctx.worker.deletePhone).toHaveBeenCalledWith('phone-1');
    expect(ctx.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'provisioning.phone_deleted' }));
    await expect(ctx.service.deletePhone(TENANT, USER, 'nope')).rejects.toMatchObject({ response: { code: 'phone_not_found' } });
    expect(ctx.worker.deletePhone).toHaveBeenCalledTimes(1);
  });

  it('starts a control session with no app or number', async () => {
    const ctx = makeService();
    await ctx.service.createJob(TENANT, USER, { egressNode: PC_ID, geelarkPhoneId: 'phone-1', mode: 'control' });
    expect(ctx.worker.createJob).toHaveBeenCalledWith(expect.objectContaining({ mode: 'control' }));
    const sent = ctx.worker.createJob.mock.calls[0][0];
    expect(sent.app).toBeUndefined();
    expect(sent.number).toBeUndefined();
  });
});
