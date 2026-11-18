import 'reflect-metadata';
import { IntegrationWhatsappCheckService, normalizeE164 } from './integration-whatsapp-check.service';

const integration = { id: 'int-1', tenant_id: 'tenant-1' } as any;

describe('normalizeE164', () => {
  it('accepts E.164 with or without +, and only digits go to Waxum', () => {
    expect(normalizeE164('+5531989739997')).toBe('5531989739997');
    expect(normalizeE164('5531989739997')).toBe('5531989739997');
    expect(normalizeE164(' +55 (31) 98973-9997 ')).toBe('5531989739997');
  });

  it('refuses anything else', () => {
    for (const value of [undefined, null, 5531989739997, '', 'abc', '+0531989739997', '1234567', '+1234567890123456', '55 31 9897x9997']) expect(normalizeE164(value)).toBeNull();
  });
});

describe('IntegrationWhatsappCheckService', () => {
  type Line = { waxum_session_id: string; verification_only?: boolean; connected?: boolean };
  const makeService = (options: { sessions?: string[]; lines?: Line[]; cached?: string | null; count?: number } = {}) => {
    const lines = options.lines ?? (options.sessions ?? ['sess-1', 'sess-2']).map((waxum_session_id) => ({ waxum_session_id }));
    const db = { query: jest.fn().mockResolvedValue({ rows: lines.map((line) => ({ verification_only: false, connected: true, ...line })) }) };
    const redis = {
      client: {
        get: jest.fn().mockResolvedValue(options.cached ?? null),
        set: jest.fn().mockResolvedValue('OK'),
        incr: jest.fn().mockResolvedValue(options.count ?? 1),
        expire: jest.fn().mockResolvedValue(1),
      },
    };
    const waxum = { checkContact: jest.fn() };
    return { service: new IntegrationWhatsappCheckService(db as any, redis as any, waxum as any), db, redis, waxum };
  };

  it('answers yes with the JID and caches the answer for 24h', async () => {
    const { service, waxum, redis } = makeService();
    waxum.checkContact.mockResolvedValue({ jid: '553189739997@s.whatsapp.net', isRegistered: true });
    await expect(service.check(integration, '+5531989739997')).resolves.toEqual({ phone: '5531989739997', on_whatsapp: true, jid: '553189739997@s.whatsapp.net' });
    expect(waxum.checkContact).toHaveBeenCalledWith('sess-1', '5531989739997');
    expect(redis.client.set).toHaveBeenCalledWith('zapcall:whatsapp-check:5531989739997', expect.any(String), 'EX', 86400);
  });

  it('answers no only when Waxum says the number is not registered', async () => {
    const { service, waxum } = makeService();
    waxum.checkContact.mockResolvedValue({ jid: '5531989739404@s.whatsapp.net', isRegistered: false });
    await expect(service.check(integration, '5531989739404')).resolves.toEqual({ phone: '5531989739404', on_whatsapp: false, jid: null });
  });

  it('serves a cached answer without touching any line or the budget', async () => {
    const { service, waxum, db, redis } = makeService({ cached: JSON.stringify({ phone: '5531989739997', on_whatsapp: false, jid: null }) });
    await expect(service.check(integration, '+5531989739997')).resolves.toEqual({ phone: '5531989739997', on_whatsapp: false, jid: null });
    expect(waxum.checkContact).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(redis.client.incr).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone with 422 invalid_phone', async () => {
    const { service, waxum } = makeService();
    await expect(service.check(integration, '12ab')).rejects.toMatchObject({ status: 422, response: { code: 'invalid_phone' } });
    await expect(service.check(integration, undefined)).rejects.toMatchObject({ status: 422, response: { code: 'invalid_phone' } });
    expect(waxum.checkContact).not.toHaveBeenCalled();
  });

  it('answers 409 no_connected_number when the tenant has no connected line', async () => {
    const { service, redis } = makeService({ sessions: [] });
    await expect(service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 409, response: { code: 'no_connected_number' } });
    expect(redis.client.incr).not.toHaveBeenCalled();
  });

  it('uses only the lines set aside for verification, never the calling lines', async () => {
    const { service, waxum } = makeService({ lines: [{ waxum_session_id: 'calls-1' }, { waxum_session_id: 'verify-1', verification_only: true }, { waxum_session_id: 'calls-2' }] });
    waxum.checkContact.mockRejectedValue(new Error('Waxum 503'));
    await expect(service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 502, response: { code: 'check_failed' } });
    expect(waxum.checkContact.mock.calls.map(([session]) => session)).toEqual(['verify-1']);
  });

  it('answers 409 verification_line_unavailable when the verification lines are all disconnected', async () => {
    const { service, waxum, redis } = makeService({ lines: [{ waxum_session_id: 'calls-1' }, { waxum_session_id: 'verify-1', verification_only: true, connected: false }] });
    await expect(service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 409, response: { code: 'verification_line_unavailable' } });
    expect(waxum.checkContact).not.toHaveBeenCalled();
    expect(redis.client.incr).not.toHaveBeenCalled();
  });

  it('answers 409 no_connected_number when no line is connected and none is set aside', async () => {
    const { service } = makeService({ lines: [{ waxum_session_id: 'calls-1', connected: false }] });
    await expect(service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 409, response: { code: 'no_connected_number' } });
  });

  it('prefers idle, non-quarantined lines of the tenant', async () => {
    const { service, db, waxum } = makeService();
    waxum.checkContact.mockResolvedValue({ jid: 'x@s.whatsapp.net', isRegistered: true });
    await service.check(integration, '+5531989739997');
    const [sql, params] = db.query.mock.calls[0];
    expect(params[0]).toBe('tenant-1');
    expect(sql).toMatch(/ORDER BY\s+EXISTS \(SELECT 1 FROM calls c[\s\S]*flagged_until > now\(\)\) ASC/);
  });

  it('answers 429 rate_limited past the per-tenant budget, before asking Waxum', async () => {
    const { service, waxum } = makeService({ count: 11 });
    await expect(service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 429, response: { code: 'rate_limited' } });
    expect(waxum.checkContact).not.toHaveBeenCalled();
  });

  it('tries another line once when the first one fails', async () => {
    const { service, waxum } = makeService();
    waxum.checkContact.mockRejectedValueOnce(new Error('Waxum 503')).mockResolvedValueOnce({ jid: 'x@s.whatsapp.net', isRegistered: true });
    await expect(service.check(integration, '+5531989739997')).resolves.toMatchObject({ on_whatsapp: true });
    expect(waxum.checkContact.mock.calls.map(([session]) => session)).toEqual(['sess-1', 'sess-2']);
  });

  it('never turns a failed or empty check into "no": it answers 502 check_failed and caches nothing', async () => {
    const failing = makeService();
    failing.waxum.checkContact.mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(failing.service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 502, response: { code: 'check_failed' } });
    expect(failing.redis.client.set).not.toHaveBeenCalled();

    const empty = makeService({ sessions: ['sess-1'] });
    empty.waxum.checkContact.mockResolvedValue(null);
    await expect(empty.service.check(integration, '+5531989739997')).rejects.toMatchObject({ status: 502, response: { code: 'check_failed' } });
    expect(empty.redis.client.set).not.toHaveBeenCalled();
  });
});

describe('lineView', () => {
  it('tells the CRM which lines are only for verification', async () => {
    const { lineView } = await import('../crm-events/crm-events.views');
    expect(lineView({ id: 'n-1', verification_only: true })).toMatchObject({ verification_only: true });
    expect(lineView({ id: 'n-2' })).toMatchObject({ verification_only: false });
  });
});
