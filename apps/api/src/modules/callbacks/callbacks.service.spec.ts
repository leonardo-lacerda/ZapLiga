jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { CallbacksService } from './callbacks.service';

describe('CallbacksService', () => {
  it('does not let an SDR act on another SDR callback', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'cb-1', assigned_sdr_id: 'sdr-2', status: 'due' }] }) };
    const service = new CallbacksService(db as any, { record: jest.fn() } as any, {} as any);
    await expect(service.cancel('tenant-1', 'cb-1', 'Sem contato', 'missed', 'user-1', 'sdr-1')).rejects.toMatchObject({ status: 403 });
  });

  it('keeps a due callback visible until explicitly resolved', async () => {
    const db = { query: jest.fn(async (sql: string) => sql.includes('SELECT cb.*') ? { rows: [{ id: 'cb-1', status: 'due', overdue: true }] } : { rows: [] }) };
    const service = new CallbacksService(db as any, { record: jest.fn() } as any, {} as any);
    await expect(service.list('tenant-1', {})).resolves.toEqual([{ id: 'cb-1', status: 'due', overdue: true }]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'due'"), ['tenant-1']);
  });

  it('starts the callback through the dialer barriers', async () => {
    const db = { query: jest.fn(async (sql: string) => sql.includes('SELECT user_id FROM sdrs')
      ? { rows: [{ user_id: 'sdr-user-2' }] }
      : { rows: [{ id: 'cb-1', lead_id: 'lead-1', assigned_sdr_id: 'sdr-2', status: 'due' }] }) };
    const dialer = { manualCallWithInput: jest.fn().mockResolvedValue({ callId: 'call-2' }) };
    const audit = { record: jest.fn() };
    const service = new CallbacksService(db as any, audit as any, dialer as any);
    await service.callNow('tenant-1', 'cb-1', 'leader-1');
    expect(dialer.manualCallWithInput).toHaveBeenCalledWith({ leadId: 'lead-1' }, 'tenant-1', 'sdr-user-2');
  });
});
