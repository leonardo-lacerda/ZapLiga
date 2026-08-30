import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { DialerService } from './dialer.service';

describe('DialerService', () => {
  const settings = { max_attempts_per_lead: 3, global_max_concurrent_calls: 5, ring_timeout_seconds: 30, dialer_round: 1 };

  const makeGateway = () => ({
    isConnected: jest.fn().mockReturnValue(true),
    getSocket: jest.fn().mockReturnValue(undefined),
    sendToSdr: jest.fn(),
    broadcast: jest.fn(),
    closeAll: jest.fn(),
  });

  const makeRedis = () => ({
    client: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn(),
      expire: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
      lrange: jest.fn().mockResolvedValue([]),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
    },
    reserve: jest.fn().mockResolvedValue('token-1'),
    release: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(undefined),
  });

  const makeWaxum = () => ({ getStatus: jest.fn(), checkContact: jest.fn(), getStoredLid: jest.fn(), openMedia: jest.fn(), waitForOutgoingAnswer: jest.fn() });

  describe('manualCall self-call guard', () => {
    const makeDb = (input: { sdrs: any[]; numbers: any[]; leads: any[] }) => {
      const query: jest.Mock = jest.fn();
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO dialer_settings')) return { rows: [] };
        if (sql.includes('SELECT * FROM dialer_settings')) return { rows: [settings] };
        if (sql.includes('FROM leads l') && sql.includes('l.id = $2')) return { rows: input.leads };
        if (sql.includes('FROM whatsapp_numbers')) return { rows: input.numbers };
        if (sql.includes('FROM sdrs s')) return { rows: input.sdrs };
        return { rows: [] };
      });
      return { query, transaction: jest.fn(async (cb: any) => cb({ query: jest.fn().mockResolvedValue({ rows: [{ folder_id: 'folder-1', is_active: true }] }) })) };
    };

    it('refuses to dial a lead whose phone matches the only available line', async () => {
      const gateway = makeGateway();
      const db = makeDb({
        sdrs: [{ id: 'sdr-1' }],
        numbers: [{ id: 'num-1', phone: '5511957632036', max_concurrent_calls: 2 }],
        leads: [{ id: 'lead-1', phone: '5511957632036', name: 'Lead' }],
      });
      const service = new DialerService(db as any, makeRedis() as any, makeWaxum() as any, gateway as any);

      await expect(service.manualCall('lead-1', 'tenant-1')).rejects.toThrow('própria linha');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('picks a different connected line when one is available', async () => {
      const gateway = makeGateway();
      const db = makeDb({
        sdrs: [{ id: 'sdr-1' }],
        numbers: [
          { id: 'num-1', phone: '5511957632036', max_concurrent_calls: 2 },
          { id: 'num-2', phone: '5585989779394', max_concurrent_calls: 2 },
        ],
        leads: [{ id: 'lead-1', phone: '5511957632036', name: 'Lead' }],
      });
      const service = new DialerService(db as any, makeRedis() as any, makeWaxum() as any, gateway as any);

      const result = await service.manualCall('lead-1', 'tenant-1');

      expect(result).toEqual(expect.objectContaining({ status: 'reserved' }));
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('allows manual dialing for a connected but unavailable SDR', async () => {
      const gateway = makeGateway();
      const db = makeDb({
        sdrs: [{ id: 'sdr-1', available: false, state: 'offline' }],
        numbers: [{ id: 'num-1', phone: '5585989779394', max_concurrent_calls: 2 }],
        leads: [{ id: 'lead-1', phone: '5511957632036', name: 'Lead' }],
      });
      const service = new DialerService(db as any, makeRedis() as any, makeWaxum() as any, gateway as any);

      const result = await service.manualCall('lead-1', 'tenant-1');

      expect(result).toEqual(expect.objectContaining({ status: 'reserved' }));
      expect((service as any).active.get(result.callId)).toEqual(expect.objectContaining({
        previousSdrAvailable: false,
        previousSdrState: 'offline',
      }));
    });

    it('does not renew a Waxum rate-limit window with another manual attempt', async () => {
      const gateway = makeGateway();
      const redis = makeRedis();
      const db = makeDb({
        sdrs: [{ id: 'sdr-1', available: false, state: 'offline' }],
        numbers: [{ id: 'num-1', phone: '5585989779394', max_concurrent_calls: 2, last_call_ended_at: new Date(Date.now() + 60_000) }],
        leads: [{ id: 'lead-1', phone: '5511957632036', name: 'Lead' }],
      });
      const service = new DialerService(db as any, redis as any, makeWaxum() as any, gateway as any);

      await expect(service.manualCall('lead-1', 'tenant-1')).rejects.toThrow('temporariamente protegida');
      expect(redis.reserve).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('refuses to dial when no SDR is connected', async () => {
      const gateway = makeGateway();
      gateway.isConnected.mockReturnValue(false);
      const db = makeDb({
        sdrs: [{ id: 'sdr-1' }],
        numbers: [{ id: 'num-1', phone: '5585989779394', max_concurrent_calls: 2 }],
        leads: [{ id: 'lead-1', phone: '5511957632036', name: 'Lead' }],
      });
      const service = new DialerService(db as any, makeRedis() as any, makeWaxum() as any, gateway as any);

      await expect(service.manualCall('lead-1', 'tenant-1')).rejects.toThrow('Nenhum SDR conectado');
    });
  });

  describe('finishCall status transitions', () => {
    const baseCallRow = {
      id: 'call-1', tenant_id: 'tenant-1', status: 'dialing', source: 'automatico',
      sdr_id: 'sdr-1', number_id: 'num-1', cooldown_seconds: 60, lead_id: 'lead-1',
      attempts: 0, max_attempts_per_lead: 3, retry_delay_minutes: 5, connected_at: null,
    };

    it('retries an automatic no_answer call within the attempt budget', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const db = { query: jest.fn().mockResolvedValue({ rows: [baseCallRow] }), transaction: jest.fn(async (cb: any) => cb(client)) };
      const redis = makeRedis();
      const service = new DialerService(db as any, redis as any, makeWaxum() as any, makeGateway() as any);

      await (service as any).finishCall('call-1', 'no_answer', undefined, false, 'tenant-1');

      const callUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes('UPDATE calls SET status'));
      expect(callUpdate[1]).toEqual(expect.arrayContaining(['retry_wait', 'no_answer']));
      const leadUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes('UPDATE leads SET status = $2'));
      expect(leadUpdate[1]).toEqual([5, 'retry_wait', 'tenant-1', 'lead-1']);
      const numberUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes('UPDATE whatsapp_numbers'));
      expect(numberUpdate[0]).toContain('last_call_ended_at = now()');
    });

    it('does not retry once the attempt budget is exhausted', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const callRow = { ...baseCallRow, attempts: 3 };
      const db = { query: jest.fn().mockResolvedValue({ rows: [callRow] }), transaction: jest.fn(async (cb: any) => cb(client)) };
      const service = new DialerService(db as any, makeRedis() as any, makeWaxum() as any, makeGateway() as any);

      await (service as any).finishCall('call-1', 'failed', undefined, false, 'tenant-1');

      const callUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes('UPDATE calls SET status'));
      expect(callUpdate[1]).toEqual(expect.arrayContaining(['failed', 'failed']));
    });

    it('treats a Waxum rate limit as transient: requeues the lead and future-dates the line by the recorded backoff', async () => {
      const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const db = { query: jest.fn().mockResolvedValue({ rows: [baseCallRow] }), transaction: jest.fn(async (cb: any) => cb(client)) };
      const redis = makeRedis();
      const gateway = makeGateway();
      const serviceWithGateway = new DialerService(db as any, redis as any, makeWaxum() as any, gateway as any);
      (serviceWithGateway as any).active.set('call-1', { tenantId: 'tenant-1', token: 'tok', numberId: 'num-1', leadId: 'lead-1', sdrId: 'sdr-1', mediaActive: false, rateLimitBackoffSeconds: 240, previousSdrAvailable: false, previousSdrState: 'offline' });

      await (serviceWithGateway as any).finishCall('call-1', 'cancelled', 'waxum_rate_limited', false, 'tenant-1');

      const leadUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes("status = 'queued'"));
      expect(leadUpdate[1]).toEqual(['tenant-1', 'lead-1']);
      const numberUpdate = client.query.mock.calls.find((call: any[]) => call[0].includes('UPDATE whatsapp_numbers'));
      expect(numberUpdate[1]).toEqual([240, 'num-1']);
      expect(redis.release).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', numberId: 'num-1' }));
      expect(gateway.sendToSdr).toHaveBeenCalledWith('sdr-1', expect.objectContaining({
        type: 'call_finished',
        available: false,
        state: 'offline',
      }));
    });
  });

  describe('line quarantine trigger (registerLineInstantFailure)', () => {
    const makeDb = () => {
      const query: jest.Mock = jest.fn();
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT label FROM whatsapp_numbers')) return { rows: [{ label: 'Linha 1' }] };
        return { rows: [] };
      });
      return { query, transaction: jest.fn() };
    };

    it('quarantines the line once consecutive instant failures reach the threshold', async () => {
      const db = makeDb();
      const redis = makeRedis();
      redis.client.incr.mockResolvedValue(2);
      const gateway = makeGateway();
      const service = new DialerService(db as any, redis as any, makeWaxum() as any, gateway as any);

      await (service as any).registerLineInstantFailure('num-1', 'tenant-1', 'call-1');

      expect(redis.client.del).toHaveBeenCalledWith('zapcall:line-failures:num-1');
      const flagUpdate = db.query.mock.calls.find((call: any[]) => call[0].includes('SET flagged_until'));
      expect(flagUpdate[1]).toEqual([6, 'num-1', 'tenant-1']);
      expect(gateway.broadcast).toHaveBeenCalledWith({ type: 'number_flagged', numberId: 'num-1', flaggedHours: 6 }, 'tenant-1');
    });

    it('does not quarantine before the failure streak reaches the threshold', async () => {
      const db = makeDb();
      const redis = makeRedis();
      redis.client.incr.mockResolvedValue(1);
      const gateway = makeGateway();
      const service = new DialerService(db as any, redis as any, makeWaxum() as any, gateway as any);

      await (service as any).registerLineInstantFailure('num-1', 'tenant-1', 'call-1');

      expect(redis.client.expire).toHaveBeenCalledWith('zapcall:line-failures:num-1', 24 * 60 * 60);
      expect(db.query.mock.calls.find((call: any[]) => call[0].includes('SET flagged_until'))).toBeUndefined();
      expect(gateway.broadcast).not.toHaveBeenCalled();
    });
  });
});
