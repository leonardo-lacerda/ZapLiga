import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { LineLossService } from './line-loss.service';

describe('LineLossService', () => {
  const make = (updated: any[], existing: any[], line: any[] = [], inserted: any[] = [{ id: 'e1' }]) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('UPDATE whatsapp_numbers SET loss_reason')) return { rows: updated };
        if (sql.startsWith('SELECT id, tenant_id, label, removal_count')) return { rows: existing };
        if (sql.startsWith('SELECT id, tenant_id, label FROM whatsapp_numbers')) return { rows: line };
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
