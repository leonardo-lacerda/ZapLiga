import { RedisService } from './redis.service';

describe('RedisService reservation scopes', () => {
  it('keeps tenant resources isolated and shares number capacity globally', async () => {
    const service = Object.create(RedisService.prototype) as RedisService & { client: { eval: jest.Mock } };
    (service as any).client = { eval: jest.fn().mockResolvedValue(1) };
    await service.reserve({ tenantId: 'tenant-b', token: 'token', globalMax: 1, numberMax: 1, maxCallsPerWindow: 3, callWindowSeconds: 180, maxCallsPerMinute: 6, minSecondsBetweenCalls: 10, numberId: 'number-1', waxumSessionId: 'session-1', leadId: 'lead-1', sdrId: 'sdr-1', ttlMs: 10_000 });
    const args = service.client.eval.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain('KEYS[6]');
    expect(String(args[0])).toContain('KEYS[7]');
    expect(String(args[0])).toContain("ZADD', KEYS[7]");
    expect(String(args[0])).toContain("ZADD', KEYS[8]");
    expect(String(args[0])).toContain('KEYS[9]');
    expect(args).toEqual(expect.arrayContaining([
      'zapcall:tenant:tenant-b:active:global',
      'zapcall:global:active:number:number-1',
      'zapcall:tenant:tenant-b:lock:lead:lead-1',
      'zapcall:tenant:tenant-b:lock:sdr:sdr-1',
      'zapcall:global:lock:number:number-1',
      'zapcall:global:lock:session:session-1',
      'zapcall:global:rate:number:number-1',
      'zapcall:tenant:tenant-b:rate:minute',
      'zapcall:tenant:tenant-b:lock:dialer-pacing',
    ]));
    expect(args).toContain(3);
    expect(args).toContain(180_000);
    expect(args).toContain(6);
    expect(args).toContain(10_000);
  });

  it('releases the session lock together with the other call resources', async () => {
    const service = Object.create(RedisService.prototype) as RedisService & { client: { eval: jest.Mock } };
    (service as any).client = { eval: jest.fn().mockResolvedValue(1) };

    await service.release({ tenantId: 'tenant-b', token: 'token', numberId: 'number-1', waxumSessionId: 'session-1', leadId: 'lead-1', sdrId: 'sdr-1' });

    const args = service.client.eval.mock.calls[0] as unknown[];
    expect(String(args[0])).toContain('for i = 3, 6 do');
    expect(args).toEqual(expect.arrayContaining([
      'zapcall:global:lock:number:number-1',
      'zapcall:global:lock:session:session-1',
    ]));
  });
});
