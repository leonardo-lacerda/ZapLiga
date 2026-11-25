import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { LineLossService, lineLossReason } from './line-loss.service';

describe('LineLossService', () => {
  it('reads a lock and a removed device as losses, and nothing else', () => {
    expect(lineLossReason('account_locked', {})).toBe('account_locked');
    expect(lineLossReason('logged_out', { data: { conflict: 'device_removed' } })).toBe('device_removed');
    expect(lineLossReason('logged_out', { data: { reason: 'ClientOutdated' } })).toBeNull();
  });

  const make = (updated: any[], existing: any[]) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('UPDATE whatsapp_numbers SET loss_reason')) return { rows: updated };
        if (sql.startsWith('SELECT id, tenant_id, label, removal_count')) return { rows: existing };
        return { rows: [] };
      }),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const gateway = { broadcastToOperations: jest.fn() };
    return { service: new LineLossService(db as any, {} as any, audit as any, gateway as any), db, audit, gateway };
  };

  it('records the loss once and tells the dashboards', async () => {
    const { service, db, audit, gateway } = make([{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 1 }], []);

    await service.handle('s1', 'logged_out', { data: { conflict: 'device_removed' } });

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO number_health_events'), ['t1', 'n1', 'device_removed', expect.any(String)]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'number.device_removed', entityId: 'n1' }));
    expect(gateway.broadcastToOperations).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ kind: 'number_lost', retired: false }) }), 't1');
  });

  it('only tells its own dashboards when the other API instance already recorded it', async () => {
    const { service, audit, gateway } = make([], [{ id: 'n1', tenant_id: 't1', label: 'Previtas 7', removal_count: 2 }]);

    await service.handle('s1', 'account_locked', {});

    expect(audit.record).not.toHaveBeenCalled();
    expect(gateway.broadcastToOperations).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.objectContaining({ lossReason: 'account_locked', retired: true }) }), 't1');
  });

  it('ignores logouts that are not a loss', async () => {
    const { service, db } = make([], []);
    await service.handle('s1', 'logged_out', { data: {} });
    expect(db.query).not.toHaveBeenCalled();
  });
});
