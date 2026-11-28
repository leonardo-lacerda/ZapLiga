import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { LineLossService } from './line-loss.service';

describe('LineLossService', () => {
  const make = (updated: any[], existing: any[], line: any[] = [], inserted: any[] = [{ id: 'e1' }]) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('UPDATE whatsapp_numbers SET loss_reason')) return { rows: updated };
        if (sql.startsWith('SELECT id, tenant_id, label, removal_count')) return { rows: existing };
        if (sql.startsWith('SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers')) return { rows: line };
        if (sql.includes('INSERT INTO line_loss_events')) return { rows: inserted };
        return { rows: [] };
      }),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const gateway = { broadcastToOperations: jest.fn() };
    return { service: new LineLossService(db as any, {} as any, audit as any, gateway as any), db, audit, gateway };
  };

  it('records the loss once, with its cause, and tells the dashboards', async () => {
    const { service, db, audit, gateway } = make([{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 1 }], []);

    await service.handle('s1', 'logged_out', { data: { conflict: 'device_removed' } });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('loss_cause = $2'), ['s1', 'device_removed', expect.any(String)]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO line_loss_events'), expect.arrayContaining(['t1', 'n1', 's1', 'device_removed']));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO number_health_events'), ['t1', 'n1', 'device_removed', expect.any(String)]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'number.device_removed', entityId: 'n1' }));
    expect(gateway.broadcastToOperations).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ kind: 'number_lost', retired: false }) }), 't1');
  });

  it('keeps what the line looked like when it fell, only for real losses', async () => {
    const { service, db } = make([{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 1 }], []);
    await service.handle('s1', 'logged_out', { data: { conflict: 'device_removed' } });
    const [sql, params] = db.query.mock.calls.find(([text]) => String(text).includes('INSERT INTO line_loss_events')) as unknown as [string, unknown[]];
    expect(sql).toContain("jsonb_build_object('context'");
    expect(sql).toContain("'callsSincePairing'");
    expect(sql).toContain('LIMIT 10');
    expect(params[11]).toBe(true);

    db.query.mockClear();
    await service.record({ id: 'n1', tenant_id: 't1' }, 's1', 'connect_failure', {}, { cause: 'transient', sourceEvent: 'connect_failure', code: null, violationType: null, violationReason: null, expiresAt: null, detail: {} });
    expect((db.query.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining([false]));
  });

  it('keeps the cause a lock states with the loss', async () => {
    const { service, db } = make([{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 1 }], []);

    await service.handle('s1', 'account_locked', { data: { details: { violation_reason: 'other_harm' } } });

    const update = db.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE whatsapp_numbers SET loss_reason')) as unknown[];
    expect(JSON.parse((update[1] as string[])[2])).toMatchObject({ violationReason: 'other_harm' });
  });

  it('only tells its own dashboards when the other API instance already recorded it', async () => {
    const { service, audit, gateway } = make([], [{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 2 }]);

    await service.handle('s1', 'account_locked', {});

    expect(audit.record).not.toHaveBeenCalled();
    expect(gateway.broadcastToOperations).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ lossReason: 'account_locked', retired: true }) }), 't1');
  });

  it('records a cause that does not take the line out without touching it', async () => {
    const { service, db, gateway } = make([], [], [{ id: 'n1', tenant_id: 't1', label: 'Previtas 7' }]);

    await service.handle('s1', 'temp_banned', { data: { code: 101, expire_secs: 600 } });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO line_loss_events'), expect.arrayContaining(['temp_banned', '101']));
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE whatsapp_numbers'), expect.anything());
    expect(gateway.broadcastToOperations).not.toHaveBeenCalled();
  });

  it('ignores events that say nothing about the line', async () => {
    const { service, db } = make([], []);
    await service.handle('s1', 'logged_out', { data: {} });
    await service.handle('s1', 'call_ack', { data: { id: 'x' } });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('LineLossService policy (LINE_LOSS_POLICY=v2)', () => {
  const env = process.env;
  beforeEach(() => { process.env = { ...env, LINE_LOSS_POLICY: 'v2' }; });
  afterAll(() => { process.env = env; });

  const make = (rows: Record<string, any[]>, timelock: unknown = null) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        for (const [needle, result] of Object.entries(rows)) if (sql.includes(needle)) return { rows: result };
        if (sql.includes('INSERT INTO line_loss_events')) return { rows: [{ id: 'e1' }] };
        return { rows: [] };
      }),
    };
    const waxum = { getReachoutTimelock: jest.fn(async () => timelock) };
    const gateway = { broadcastToOperations: jest.fn() };
    return { service: new LineLossService(db as any, waxum as any, { record: jest.fn() } as any, gateway as any), db, waxum, gateway };
  };
  const line = { id: 'n1', tenant_id: 't1', label: 'Previtas 7', waxum_session_id: 's1' };
  const blockCall = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]) => String(sql).includes('SET dial_blocked_until')) as [string, unknown[]] | undefined;

  it('holds a temporarily banned line until the ban ends', async () => {
    const { service, db, gateway } = make({ 'SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers': [line] });

    await service.handle('s1', 'temp_banned', { data: { code: 101, expire_secs: 7200 } });

    const call = blockCall(db);
    expect(call?.[1].slice(0, 2)).toEqual(['n1', 't1']);
    expect(call?.[1][3]).toBe('temp_banned');
    expect((call?.[1][2] as Date).getTime()).toBeGreaterThan(Date.now() + 7_100_000);
    expect(gateway.broadcastToOperations).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ kind: 'number_dial_blocked', cause: 'temp_banned' }) }), 't1');
  });

  it('reads the end of a reachout timelock from the server on a 463', async () => {
    const end = Math.floor(Date.now() / 1000) + 3 * 3600;
    const { service, db, waxum } = make({ 'SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers': [line] }, { is_active: true, time_enforcement_ends: String(end) });

    await service.handle('s1', 'call_ack', { data: { error: '463' } });

    expect(waxum.getReachoutTimelock).toHaveBeenCalledWith('s1');
    expect((blockCall(db)?.[1][2] as Date).getTime()).toBe(end * 1000);
  });

  it('does nothing to the dialer for a transient cause', async () => {
    const { service, db } = make({ 'SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers': [line] });
    await service.handle('s1', 'stream_error', { data: { code: '503' } });
    expect(blockCall(db)).toBeUndefined();
  });

  it('only the instance that stored the event applies the policy', async () => {
    const { service, db, waxum } = make({ 'SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers': [line], 'INSERT INTO line_loss_events': [] });
    await service.handle('s1', 'call_ack', { data: { error: '463' } });
    expect(waxum.getReachoutTimelock).not.toHaveBeenCalled();
    expect(blockCall(db)).toBeUndefined();
  });

  it('pauses a line briefly after a streak of calls without audio and without a 463', async () => {
    const { service, db } = make({ 'SELECT id, tenant_id, label, waxum_session_id, dial_block_cause': [line] });

    expect(await service.onInstantFailure('n1', 't1', 'c1', false)).toBeNull();
    const until = await service.onInstantFailure('n1', 't1', 'c2', true);

    expect(blockCall(db)?.[1][3]).toBe('media_failure');
    expect(until!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it('holds the line at once when the call got a 463', async () => {
    const { service, db } = make({ 'SELECT id, tenant_id, label, waxum_session_id, dial_block_cause': [line], 'FROM call_signal_events': [{ '?column?': 1 }] });
    const until = await service.onInstantFailure('n1', 't1', 'c1', false);
    expect(blockCall(db)?.[1][3]).toBe('reachout_timelock');
    expect(until).not.toBeNull();
  });

  it('stays off without LINE_LOSS_POLICY=v2', async () => {
    process.env = { ...env };
    const { service, db } = make({ 'SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers': [line] });
    await service.handle('s1', 'temp_banned', { data: { code: 101, expire_secs: 600 } });
    expect(blockCall(db)).toBeUndefined();
  });
});
