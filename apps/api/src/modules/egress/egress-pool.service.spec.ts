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
    return { service: new EgressPoolService(db as any, redis as any, egress as any, numbers as any), numbers, db };
  }

  it('does not hand a line back to a PC that only just came back', async () => {
    const { service, numbers } = pool(
      [{ slot: 'edge-1', online: true, gone: false, steady: false }],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'main', status: 'connected' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('moves the lines of a PC that went away to a steady PC', async () => {
    const { service, numbers } = pool(
      [
        { slot: 'edge-1', online: false, gone: true, steady: null },
        { slot: 'edge-2', online: true, gone: false, steady: true },
      ],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-1', status: 'connected' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).toHaveBeenCalledWith('t1', null, 'l1', 'edge-2');
  });

  it('also moves the lines that lost their connection when their PC went away', async () => {
    const { service, numbers } = pool(
      [
        { slot: 'edge-2', online: false, gone: true, steady: null },
        { slot: 'edge-1', online: true, gone: false, steady: true },
      ],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-2', status: 'waiting_for_qr' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).toHaveBeenCalledWith('t1', null, 'l1', 'edge-1');
  });

  it('never sends the lines of a PC that went away to the VPS when no other PC is online', async () => {
    const { service, numbers } = pool(
      [{ slot: 'edge-1', online: false, gone: true, steady: null }],
      [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-1', status: 'connected' }],
    );
    await service.tick();
    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('leaves out lines WhatsApp removed and lines paired in the last 30 minutes', async () => {
    const { service, db } = pool([], []);
    await service.tick();
    const [sql, params] = db.query.mock.calls[2];
    expect(sql).toContain('loss_reason IS NULL');
    expect(sql).toContain('last_paired_at < now() - make_interval(mins => $1)');
    expect(params).toEqual([30]);
  });
});
