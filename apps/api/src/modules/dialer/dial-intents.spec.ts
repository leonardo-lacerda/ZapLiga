import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { DialerService } from './dialer.service';
import { DialRefusedError, dialIntentKey, sanitizeExternalRef } from './dial-intents';

describe('sanitizeExternalRef', () => {
  it('keeps a flat map of short identifiers and drops empty values', () => {
    expect(sanitizeExternalRef({ account_id: 2, contact_id: 'c-9', lead_id: null })).toEqual({ account_id: 2, contact_id: 'c-9' });
    expect(sanitizeExternalRef(undefined)).toBeNull();
    expect(sanitizeExternalRef({})).toBeNull();
  });

  it('rejects nested values, odd keys and oversized maps', () => {
    expect(() => sanitizeExternalRef({ contact: { id: 1 } })).toThrow(DialRefusedError);
    expect(() => sanitizeExternalRef({ 'bad key': 'x' })).toThrow(DialRefusedError);
    expect(() => sanitizeExternalRef(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])))).toThrow(DialRefusedError);
    expect(() => sanitizeExternalRef(['a'])).toThrow(DialRefusedError);
  });
});

describe('DialerService dial intents', () => {
  const line = { id: 'num-1', tenant_id: 'tenant-1', phone: '5585900000000', status: 'connected', flagged_until: null, last_call_ended_at: null, max_concurrent_calls: 1, active_calls: 0 };

  const makeService = (overrides: { sdrs?: any[]; numbers?: any[]; suppressed?: boolean; busy?: boolean; stationAlive?: boolean; storedIntent?: any } = {}) => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM sdrs s WHERE s.tenant_id = $1 AND s.id = $2')) return { rows: overrides.sdrs ?? [{ id: 'sdr-1', connection_instance_id: 'instance-a' }] };
      if (sql.includes('FROM whatsapp_numbers n')) return { rows: overrides.numbers ?? [line] };
      if (sql.includes('FROM contact_suppressions')) return { rows: overrides.suppressed ? [{ 1: 1 }] : [] };
      if (sql.includes('FROM calls WHERE tenant_id = $1 AND sdr_id = $2')) return { rows: overrides.busy ? [{ 1: 1 }] : [] };
      if (sql.includes('SELECT user_id FROM sdrs')) return { rows: [{ user_id: 'user-1' }] };
      return { rows: [] };
    });
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ current_pause_id: null }] }) };
    const db = { query, transaction: jest.fn(async (cb: any) => cb(client)) };
    const redis = {
      client: {
        exists: jest.fn().mockResolvedValue(overrides.stationAlive === false ? 0 : 1),
        set: jest.fn().mockResolvedValue('OK'),
        getdel: jest.fn().mockResolvedValue(overrides.storedIntent === undefined ? null : JSON.stringify(overrides.storedIntent)),
      },
    };
    const service = new DialerService(db as any, redis as any, {} as any, {} as any);
    return { service, db, redis, client };
  };

  const input = { tenantId: 'tenant-1', integrationId: 'int-1', sdrId: 'sdr-1', numberId: 'num-1', phone: '+55 (11) 99999-0000', name: 'Ana', externalRef: { contact_id: 7 } };

  it('stores a single-use intent with a short TTL when every check passes', async () => {
    const { service, redis } = makeService();
    const result = await service.createDialIntent(input);
    expect(result.intent_id).toEqual(expect.any(String));
    const [key, payload, mode, ttl] = redis.client.set.mock.calls[0];
    expect(key).toBe(dialIntentKey(result.intent_id));
    expect(JSON.parse(payload)).toMatchObject({ sdrId: 'sdr-1', numberId: 'num-1', phone: '5511999990000', externalRef: { contact_id: 7 } });
    expect([mode, ttl]).toEqual(['EX', 60]);
  });

  it.each([
    ['station_offline', { stationAlive: false }],
    ['agent_busy', { busy: true }],
    ['line_not_found', { numbers: [] }],
    ['line_disconnected', { numbers: [{ ...line, status: 'disconnected' }] }],
    ['line_busy', { numbers: [{ ...line, active_calls: 1 }] }],
    ['self_call', { numbers: [{ ...line, phone: '5511999990000' }] }],
    ['suppressed', { suppressed: true }],
    ['agent_not_eligible', { sdrs: [] }],
  ])('refuses with %s', async (code, overrides) => {
    const { service, redis } = makeService(overrides as any);
    await expect(service.createDialIntent(input)).rejects.toMatchObject({ code });
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('reports how long a protected line stays unavailable', async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    const { service } = makeService({ numbers: [{ ...line, last_call_ended_at: until }] });
    const error = await service.createDialIntent(input).catch((caught) => caught);
    expect(error).toBeInstanceOf(DialRefusedError);
    expect(error.code).toBe('line_protected');
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(89);
  });

  it('refuses an expired intent and an intent issued for another agent', async () => {
    await expect(makeService().service.dialFromIntent('intent-1', 'sdr-1', 'tenant-1')).rejects.toMatchObject({ code: 'intent_expired' });
    const stolen = makeService({ storedIntent: { id: 'intent-1', tenantId: 'tenant-1', sdrId: 'sdr-2' } });
    await expect(stolen.service.dialFromIntent('intent-1', 'sdr-1', 'tenant-1')).rejects.toMatchObject({ code: 'intent_mismatch' });
  });

  it('redeems an intent as a manual call on the chosen line, carrying the CRM reference', async () => {
    const intent = { id: 'intent-1', tenantId: 'tenant-1', integrationId: 'int-1', sdrId: 'sdr-1', numberId: 'num-1', phone: '5511999990000', name: 'Ana', externalRef: { contact_id: 7 }, leadExternalId: 'franco:2:7' };
    const { service } = makeService({ storedIntent: intent });
    const manual = jest.spyOn(service, 'manualCallWithInput').mockResolvedValue({ callId: 'call-1', status: 'reserved', leadId: 'lead-1' } as any);
    await expect(service.dialFromIntent('intent-1', 'sdr-1', 'tenant-1')).resolves.toMatchObject({ callId: 'call-1' });
    expect(manual).toHaveBeenCalledWith({
      phone: '5511999990000', name: 'Ana', numberId: 'num-1',
      integration: { integrationId: 'int-1', externalRef: { contact_id: 7 }, leadExternalId: 'franco:2:7' },
    }, 'tenant-1', 'user-1');
  });

  it('releases a post-call pause the CRM never finished before the next call', async () => {
    const intent = { id: 'intent-1', tenantId: 'tenant-1', integrationId: 'int-1', sdrId: 'sdr-1', numberId: 'num-1', phone: '5511999990000', name: '', externalRef: null, leadExternalId: null };
    const { service, client } = makeService({ storedIntent: intent });
    client.query.mockResolvedValueOnce({ rows: [{ current_pause_id: 'pause-1' }] });
    jest.spyOn(service, 'manualCallWithInput').mockResolvedValue({ callId: 'call-1', status: 'reserved', leadId: 'lead-1' } as any);
    await service.dialFromIntent('intent-1', 'sdr-1', 'tenant-1');
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.startsWith('UPDATE sdr_pauses SET ended_at'))).toBe(true);
    expect(statements.some((sql) => sql.includes('current_pause_id = NULL'))).toBe(true);
  });
});

describe('DialerService CRM events', () => {
  const callRow = {
    id: 'call-1', tenant_id: 'tenant-1', status: 'media_active', source: 'manual', sdr_id: 'sdr-1', number_id: 'num-1', cooldown_seconds: 60,
    lead_id: 'lead-1', attempts: 0, max_attempts_per_lead: 3, retry_delay_minutes: 5, connected_at: '2026-10-15T01:00:00Z',
  };
  const makeService = (row: any) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'pause-1', pause_type: 'post_call', started_at: '2026-10-15T01:02:00Z' }] }) };
    const db = { query: jest.fn().mockResolvedValue({ rows: [row] }), transaction: jest.fn(async (cb: any) => cb(client)) };
    const gateway = { sendToSdr: jest.fn(), broadcast: jest.fn(), broadcastToOperations: jest.fn() };
    const redis = { client: { lpush: jest.fn().mockResolvedValue(1), ltrim: jest.fn().mockResolvedValue('OK') }, release: jest.fn() };
    const crmEvents = { recordCall: jest.fn().mockResolvedValue(undefined), recordLine: jest.fn().mockResolvedValue(undefined) };
    const service = new DialerService(db as any, redis as any, {} as any, gateway as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, crmEvents as any);
    return { service, crmEvents };
  };

  it('reports the end of a call the CRM placed', async () => {
    const { service, crmEvents } = makeService({ ...callRow, integration_id: 'int-1' });
    await (service as any).finishCall('call-1', 'completed', 'remote_hangup', false, 'tenant-1');
    expect(crmEvents.recordCall).toHaveBeenCalledWith('tenant-1', 'call-1', 'call.ended', undefined);
  });

  it('stays silent for calls the CRM did not place', async () => {
    const { service, crmEvents } = makeService({ ...callRow, integration_id: null });
    await (service as any).finishCall('call-1', 'completed', 'remote_hangup', false, 'tenant-1');
    expect(crmEvents.recordCall).not.toHaveBeenCalled();
  });

  it('never lets a CRM outbox failure break the call path', async () => {
    const { service, crmEvents } = makeService({ ...callRow, integration_id: 'int-1' });
    crmEvents.recordCall.mockRejectedValueOnce(new Error('outbox down'));
    await expect((service as any).finishCall('call-1', 'completed', 'remote_hangup', false, 'tenant-1')).resolves.toBeUndefined();
  });
});
