import { RedisService } from './redis.service';

describe('RedisService reservation scopes', () => {
  it('keeps tenant resources isolated and shares number capacity globally', async () => {
    const service = Object.create(RedisService.prototype) as RedisService & { client: { eval: jest.Mock } };
    (service as any).client = { eval: jest.fn().mockResolvedValue(1) };
    await service.reserve({ tenantId: 'tenant-b', token: 'token', globalMax: 1, numberMax: 1, numberId: 'number-1', leadId: 'lead-1', sdrId: 'sdr-1', ttlMs: 10_000 });
    const args = service.client.eval.mock.calls[0] as unknown[];
    expect(args).toEqual(expect.arrayContaining([
      'zapcall:tenant:tenant-b:active:global',
      'zapcall:global:active:number:number-1',
      'zapcall:tenant:tenant-b:lock:lead:lead-1',
      'zapcall:tenant:tenant-b:lock:sdr:sdr-1',
      'zapcall:global:lock:number:number-1',
    ]));
  });
});
