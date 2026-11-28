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
    const egress = { syncPcs: jest.fn().mockResolvedValue(undefined), recordSilentPcs: jest.fn().mockResolvedValue(undefined) };
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

type Pc = { slot: string; fallback: string; online: boolean; gone: boolean; steady: boolean | null };
type Line = { id: string; tenant_id: string; waxum_node: string; status: string };

const build = (pcs: Pc[], lines: Line[]) => {
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM egress_settings')) return { rows: [{ pool_enabled: true, max_numbers_per_pc: 5, offline_grace_seconds: 60 }] };
      if (sql.includes('FROM egress_pcs')) return { rows: pcs };
      if (sql.includes('FROM whatsapp_numbers')) return { rows: lines };
      return { rows: [] };
    }),
  };
  const redis = { acquireLock: jest.fn(async () => true) };
  const egress = { syncPcs: jest.fn(async () => undefined), recordSilentPcs: jest.fn(async () => undefined) };
  const numbers = { moveToWaxumNode: jest.fn(async () => ({})) };
  const service = new EgressPoolService(db as any, redis as any, egress as any, numbers as any);
  return { service, numbers };
};

const pcGone: Pc = { slot: 'edge-2', fallback: 'vps', online: false, gone: true, steady: null };
const pcOnline: Pc = { slot: 'edge-1', fallback: 'offline', online: true, gone: false, steady: true };

describe('EgressPoolService.tick', () => {
  it('moves a line waiting for the QR off a PC that is gone to the online PC', async () => {
    const { service, numbers } = build([pcGone, pcOnline], [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-2', status: 'waiting_for_qr' }]);

    await service.tick();

    expect(numbers.moveToWaxumNode).toHaveBeenCalledWith('t1', null, 'l1', 'edge-1');
  });

  it('does not send a disconnected line to the VPS when no PC is online', async () => {
    const { service, numbers } = build([pcGone, { ...pcOnline, online: false }], [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-2', status: 'disconnected' }]);

    await service.tick();

    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('never moves a connected line of a gone PC to the VPS', async () => {
    const { service, numbers } = build([pcGone], [{ id: 'l1', tenant_id: 't1', waxum_node: 'edge-2', status: 'connected' }]);

    await service.tick();

    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('leaves a disconnected line on the VPS where it is', async () => {
    const { service, numbers } = build([pcOnline], [{ id: 'l1', tenant_id: 't1', waxum_node: 'main', status: 'disconnected' }]);

    await service.tick();

    expect(numbers.moveToWaxumNode).not.toHaveBeenCalled();
  });

  it('keeps going after a move that fails', async () => {
    const { service, numbers } = build([pcGone, pcOnline], [
      { id: 'l1', tenant_id: 't1', waxum_node: 'edge-2', status: 'waiting_for_qr' },
      { id: 'l2', tenant_id: 't1', waxum_node: 'edge-2', status: 'connected' },
    ]);
    numbers.moveToWaxumNode.mockRejectedValueOnce(new Error('boom'));

    await service.tick();

    expect(numbers.moveToWaxumNode).toHaveBeenCalledTimes(2);
  });
});
