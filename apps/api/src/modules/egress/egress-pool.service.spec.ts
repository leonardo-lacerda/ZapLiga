import { EgressPoolService } from './egress-pool.service';

describe('EgressPoolService', () => {
  function pool(pcs: any[], lines: any[]) {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ pool_enabled: true, max_numbers_per_pc: 5, offline_grace_seconds: 60 }] })
        .mockResolvedValueOnce({ rows: pcs })
        .mockResolvedValueOnce({ rows: lines }),
    };
    const redis = { acquireLock: jest.fn().mockResolvedValue(true) };
    const egress = { syncPcs: jest.fn().mockResolvedValue(undefined) };
    const numbers = { moveToWaxumNode: jest.fn().mockResolvedValue({}) };
    return { service: new EgressPoolService(db as any, redis as any, egress as any, numbers as any), numbers };
  }

  it('does not hand a line back to a PC that only just came back', async () => {
    const { service, numbers } = pool(
      [{ slot: 'edge-1', fallback: 'vps', online: true, gone: false, steady: false }],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'main', status: 'connected' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('moves the lines of a PC that went away to a steady PC', async () => {
    const { service, numbers } = pool(
      [
        { slot: 'edge-1', fallback: 'vps', online: false, gone: true, steady: null },
        { slot: 'edge-2', fallback: 'offline', online: true, gone: false, steady: true },
      ],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-1', status: 'connected' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).toHaveBeenCalledWith('t1', null, 'l1', 'edge-2');
  });
});
