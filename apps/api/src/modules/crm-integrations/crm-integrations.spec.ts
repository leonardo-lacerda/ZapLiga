import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { ExecutionContext } from '@nestjs/common';
import { hashCredential, decryptSecret } from '../lead-ingestion/lead-ingestion.crypto';
import { CrmIntegrationsService, normalizeIntegrationUrl, normalizeOrigins } from './crm-integrations.service';
import { IntegrationKeyGuard } from './crm-integration.guard';
import { IntegrationAgentsService } from './integration-agents.service';
import { IntegrationCallsService } from './integration-calls.service';

const integration = {
  id: 'int-1', tenant_id: 'tenant-1', kind: 'franco', name: 'Franco', public_id: 'crm_x', api_key_prefix: 'zpl_crm_abc',
  scopes: ['calls', 'numbers:read', 'numbers:write', 'agents', 'webhooks'], status: 'active', webhook_url: null, allowed_origins: [],
  external_account_id: null, connected_at: null, last_used_at: null, created_at: '2026-10-14T00:00:00Z', revoked_at: null,
};

describe('CrmIntegrationsService', () => {
  const makeService = () => {
    const db = { query: jest.fn(async (_sql: string, params: unknown[] = []) => ({ rows: [{ ...integration, api_key_hash: params[5], webhook_url: params[0] }] })) };
    const redis = { client: { set: jest.fn().mockResolvedValue('OK') } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return { service: new CrmIntegrationsService(db as any, redis as any, audit as any, {} as any, {} as any), db, audit };
  };

  it('returns the API key once and stores only its hash', async () => {
    const { service, db } = makeService();
    const created = await service.create('tenant-1', 'user-1', { name: 'Franco' });
    expect(created.api_key).toMatch(/^zpl_crm_/);
    const params = db.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(hashCredential(created.api_key));
    expect(params).not.toContain(created.api_key);
    expect(params[4]).toBe(created.api_key.slice(0, 16));
  });

  it('never looks up keys of another format', async () => {
    const { service, db } = makeService();
    await expect(service.authenticate('zpl_in_lead-ingestion-key')).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('issues a fresh webhook secret on handshake and stores it encrypted', async () => {
    const { service, db } = makeService();
    const result = await service.handshake(integration as any, { webhookUrl: 'https://franco.example.com/webhooks/zapcall/abc', allowedOrigins: ['https://franco.example.com/'] });
    expect(result.webhook_secret).toMatch(/^zpl_whsec_/);
    const params = db.query.mock.calls[0][1] as unknown[];
    expect(decryptSecret(String(params[1]))).toBe(result.webhook_secret);
    expect(params[2]).toEqual(['https://franco.example.com']);
  });

  it('accepts HTTPS URLs, and plain HTTP only for local hosts outside production', () => {
    expect(normalizeIntegrationUrl('https://crm.example.com/hook', 'URL').host).toBe('crm.example.com');
    expect(normalizeIntegrationUrl('http://localhost:13001/hook', 'URL').host).toBe('localhost:13001');
    expect(() => normalizeIntegrationUrl('http://crm.example.com/hook', 'URL')).toThrow('HTTPS');
    expect(() => normalizeIntegrationUrl('https://user:pass@crm.example.com', 'URL')).toThrow('credenciais');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(() => normalizeIntegrationUrl('http://localhost:13001/hook', 'URL')).toThrow('HTTPS'); }
    finally { process.env.NODE_ENV = previous; }
    expect(normalizeOrigins(['https://a.example.com/path', 'https://a.example.com'])).toEqual(['https://a.example.com']);
  });
});

describe('IntegrationKeyGuard', () => {
  const makeContext = (request: any, scope?: string) => ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => scope,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

  const makeGuard = (options: { found?: any; count?: number } = {}) => {
    const reflector = { getAllAndOverride: jest.fn((_key: string, [handler]: any[]) => handler) };
    const integrations = { authenticate: jest.fn().mockResolvedValue(options.found === undefined ? integration : options.found), touch: jest.fn().mockResolvedValue(undefined) };
    const redis = { client: { incr: jest.fn().mockResolvedValue(options.count ?? 1), expire: jest.fn().mockResolvedValue(1) }, incrementMetric: jest.fn().mockResolvedValue(undefined) };
    const flags = { assertEnabled: jest.fn().mockResolvedValue(undefined) };
    return { guard: new IntegrationKeyGuard(reflector as any, integrations as any, redis as any, flags as any), integrations, flags };
  };

  it('binds the request to the key tenant, whatever header the caller sends', async () => {
    const { guard, flags } = makeGuard();
    const request: any = { headers: { authorization: 'Bearer zpl_crm_key', 'x-tenant-id': 'other-tenant' }, method: 'POST' };
    await expect(guard.canActivate(makeContext(request, 'calls'))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-1');
    expect(request.integration.id).toBe('int-1');
    expect(flags.assertEnabled).toHaveBeenCalledWith('tenant-1', 'crm_integration', 'POST');
  });

  it('rejects a missing or unknown key, a missing scope and a flood', async () => {
    await expect(makeGuard().guard.canActivate(makeContext({ headers: {} }))).rejects.toMatchObject({ status: 401 });
    await expect(makeGuard({ found: null }).guard.canActivate(makeContext({ headers: { 'x-zapliga-api-key': 'zpl_crm_x' } }))).rejects.toMatchObject({ status: 401 });
    const limited = makeGuard({ found: { ...integration, scopes: ['numbers:read'] } });
    await expect(limited.guard.canActivate(makeContext({ headers: { 'x-zapliga-api-key': 'zpl_crm_x' } }, 'calls'))).rejects.toMatchObject({ status: 403 });
    await expect(makeGuard({ count: 601 }).guard.canActivate(makeContext({ headers: { 'x-zapliga-api-key': 'zpl_crm_x' } }))).rejects.toMatchObject({ status: 429 });
  });
});

describe('IntegrationAgentsService', () => {
  const makeService = (state: { user?: any; membership?: any; sdr?: any; linked?: any }) => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT id, name, email, status, platform_role FROM users')) return { rows: state.user ? [state.user] : [] };
        if (sql.startsWith('INSERT INTO users')) return { rows: [{ id: 'user-new', name: 'Ana', email: 'ana@x.com', status: 'active', platform_role: 'user' }] };
        if (sql.startsWith('SELECT role, status FROM tenant_memberships')) return { rows: state.membership ? [state.membership] : [] };
        if (sql.startsWith('SELECT id, operator_kind FROM sdrs')) return { rows: state.sdr ? [state.sdr] : [] };
        if (sql.startsWith('INSERT INTO sdrs')) return { rows: [{ id: 'sdr-new', operator_kind: 'sdr' }] };
        return { rows: [] };
      }),
    };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT 1 FROM users')) return { rows: state.user ? [{ 1: 1 }] : [] };
        if (sql.includes('FROM crm_integration_agents a JOIN sdrs s')) return { rows: state.linked ? [state.linked] : [] };
        return { rows: [] };
      }),
      transaction: jest.fn(async (cb: any) => cb(client)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const auth = { createWebsocketTicket: jest.fn().mockResolvedValue({ ticket: 'ticket-1', expiresAt: new Date('2026-10-14T12:01:00Z') }) };
    const entitlement = { assertAction: jest.fn().mockResolvedValue(undefined), acquireTenantLock: jest.fn().mockResolvedValue(undefined) };
    const capacity = { assertCanAdd: jest.fn().mockResolvedValue({}) };
    const users = { hashPassword: jest.fn().mockResolvedValue('hash') };
    const service = new IntegrationAgentsService(db as any, audit as any, auth as any, entitlement as any, capacity as any, users as any);
    return { service, client, capacity, auth, users };
  };

  it('links an existing SDR without taking another seat', async () => {
    const { service, capacity, users } = makeService({ user: { id: 'user-1', name: 'Ana', status: 'active', platform_role: 'user' }, membership: { role: 'sdr', status: 'active' }, sdr: { id: 'sdr-1', operator_kind: 'sdr' } });
    const result = await service.ensure(integration as any, { externalUserId: '12', email: 'Ana@X.com', name: 'Ana' });
    expect(result).toMatchObject({ sdr_id: 'sdr-1', user_id: 'user-1', operator_kind: 'sdr', provisioned: false, external_user_id: '12' });
    expect(capacity.assertCanAdd).not.toHaveBeenCalled();
    expect(users.hashPassword).not.toHaveBeenCalled();
  });

  it('keeps a leader a leader', async () => {
    const { service, capacity } = makeService({ user: { id: 'user-1', name: 'Leo', status: 'active', platform_role: 'user' }, membership: { role: 'leader', status: 'active' }, sdr: { id: 'sdr-1', operator_kind: 'leader' } });
    await expect(service.ensure(integration as any, { externalUserId: '1', email: 'leo@x.com', name: 'Leo' })).resolves.toMatchObject({ operator_kind: 'leader', provisioned: false });
    expect(capacity.assertCanAdd).not.toHaveBeenCalled();
  });

  it('provisions an unknown person as an SDR, checking the seat limit', async () => {
    const { service, client, capacity } = makeService({});
    const result = await service.ensure(integration as any, { externalUserId: '13', email: 'nova@x.com', name: 'Nova' });
    expect(capacity.assertCanAdd).toHaveBeenCalledWith('tenant-1', client);
    expect(result).toMatchObject({ sdr_id: 'sdr-new', operator_kind: 'sdr', provisioned: true });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO tenant_memberships"))).toBe(true);
  });

  it('refuses a blocked user', async () => {
    const { service } = makeService({ user: { id: 'user-1', status: 'blocked', platform_role: 'user' } });
    await expect(service.ensure(integration as any, { externalUserId: '1', email: 'x@x.com', name: 'X' })).rejects.toMatchObject({ status: 409 });
  });

  it('issues a station ticket tagged with the integration', async () => {
    const { service, auth } = makeService({ linked: { user_id: 'user-1' } });
    const ticket = await service.stationTicket(integration as any, 'sdr-1');
    expect(auth.createWebsocketTicket).toHaveBeenCalledWith('user-1', 'tenant-1', true, 'int-1');
    expect(ticket).toMatchObject({ ticket: 'ticket-1', sdr_id: 'sdr-1', ws_url: expect.stringMatching(/^ws.*\/ws\/tenants\/tenant-1\/sdr$/) });
  });

  it('refuses a ticket for an agent the integration did not link', async () => {
    await expect(makeService({}).service.stationTicket(integration as any, 'sdr-9')).rejects.toMatchObject({ status: 404 });
  });
});

describe('IntegrationCallsService', () => {
  const callRow = { id: 'call-1', tenant_id: 'tenant-1', status: 'media_active', integration_id: 'int-1', number_id: 'num-1', sdr_id: 'sdr-1', lead_id: 'lead-1', external_ref: { call_id: 'f-1' } };
  const makeService = (rows: { call?: any; pause?: any; linked?: boolean } = {}) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM crm_integration_agents WHERE integration_id')) return { rows: rows.linked === false ? [] : [{ 1: 1 }] };
        if (sql.includes('FROM calls c')) return { rows: rows.call === undefined ? [callRow] : rows.call ? [rows.call] : [] };
        if (sql.includes('FROM sdr_pauses')) return { rows: rows.pause ? [rows.pause] : [] };
        return { rows: [] };
      }),
    };
    const redis = { client: { publish: jest.fn().mockResolvedValue(1) } };
    const dialer = { createDialIntent: jest.fn().mockResolvedValue({ intent_id: 'intent-1' }), hangupIfOwned: jest.fn().mockResolvedValue(false), finishPause: jest.fn().mockResolvedValue({ ok: true }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new IntegrationCallsService(db as any, redis as any, dialer as any, audit as any, {} as any);
    return { service, dialer, redis };
  };

  it('only pre-authorizes calls for agents the integration linked', async () => {
    await expect(makeService({ linked: false }).service.createDialIntent(integration as any, { sdrId: 'sdr-9', numberId: 'num-1', phone: '11999990000' })).rejects.toMatchObject({ status: 404 });
    const { service, dialer } = makeService();
    await service.createDialIntent(integration as any, { sdrId: 'sdr-1', numberId: 'num-1', phone: '11999990000', externalRef: { call_id: 'f-1' } });
    expect(dialer.createDialIntent).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', integrationId: 'int-1', externalRef: { call_id: 'f-1' } }));
  });

  it('turns a dialer refusal into a 409 with its code', async () => {
    const { service, dialer } = makeService();
    const { DialRefusedError } = await import('../dialer/dial-intents');
    dialer.createDialIntent.mockRejectedValueOnce(new DialRefusedError('line_protected', 'Linha protegida', 40));
    await expect(service.createDialIntent(integration as any, { sdrId: 'sdr-1', numberId: 'num-1', phone: '11999990000' })).rejects.toMatchObject({ status: 409, response: { code: 'line_protected', retry_after_seconds: 40 } });
  });

  it('forwards a hang-up to the instance that owns the call', async () => {
    const { service, redis } = makeService();
    await expect(service.hangup(integration as any, 'call-1')).resolves.toMatchObject({ requested: true });
    expect(redis.client.publish).toHaveBeenCalledWith('zapcall:crm-integration:call-control', JSON.stringify({ action: 'hangup', callId: 'call-1', tenantId: 'tenant-1' }));
  });

  it('does not hang up a finished call', async () => {
    const { service, dialer } = makeService({ call: { ...callRow, status: 'completed' } });
    await expect(service.hangup(integration as any, 'call-1')).resolves.toMatchObject({ already_finished: true });
    expect(dialer.hangupIfOwned).not.toHaveBeenCalled();
  });

  it('finishes the post-call pause with the stage the result implies, keeping the agent unavailable', async () => {
    const { service, dialer } = makeService({ pause: { id: 'pause-1', sdr_id: 'sdr-1' } });
    await service.wrapUp(integration as any, 'call-1', { callResult: 'reuniao_agendada' });
    expect(dialer.finishPause).toHaveBeenCalledWith('sdr-1', 'pause-1', expect.objectContaining({ callResult: 'reuniao_agendada', pipelineStage: 'reuniao', continueAvailable: false, notes: expect.any(String) }), 'tenant-1');
  });

  it('reports a wrap-up that arrives after the pause was released', async () => {
    await expect(makeService().service.wrapUp(integration as any, 'call-1', { callResult: 'interessado' })).rejects.toMatchObject({ status: 409, response: { code: 'wrap_up_closed' } });
  });
});
