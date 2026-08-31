import { PrivacyService } from './privacy.service';

describe('PrivacyService tenant isolation', () => {
  it('scopes every subject lookup to the selected tenant', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new PrivacyService(db as any, { record: jest.fn() } as any);

    const result = await service.subject('tenant-a', '+55 (11) 99999-0000');

    expect(result.phone).toBe('5511999990000');
    expect(db.query).toHaveBeenCalledTimes(4);
    for (const call of db.query.mock.calls) expect(call[1]).toEqual(['tenant-a', '5511999990000']);
  });

  it('never returns an expired or cross-tenant export', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new PrivacyService(db as any, { record: jest.fn() } as any);

    await expect(service.downloadExport('tenant-a', 'request-from-b', 'leader-a')).rejects.toMatchObject({ status: 404 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = $1'), ['tenant-a', 'request-from-b']);
  });
});
