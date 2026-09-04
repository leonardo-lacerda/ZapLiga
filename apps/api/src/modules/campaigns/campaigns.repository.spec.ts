import { CampaignsRepository } from './campaigns.repository';

describe('CampaignsRepository', () => {
  it('scopes both count and list queries by tenant', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'campaign-a', tenant_id: 'tenant-a' }] }) };
    const repository = new CampaignsRepository(db as any);

    const result = await repository.list('tenant-a', 'running', 25, 5);

    expect(result.total).toBe(1);
    expect(db.query.mock.calls[0][0]).toContain('c.tenant_id = $1');
    expect(db.query.mock.calls[0][1]).toEqual(['tenant-a', 'running']);
    expect(db.query.mock.calls[1][0]).toContain('c.tenant_id = $1');
    expect(db.query.mock.calls[1][1]).toEqual(['tenant-a', 'running', 25, 5]);
  });

  it('uses tenant and campaign id together for detail reads', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new CampaignsRepository(db as any);

    expect(await repository.findById('tenant-b', 'campaign-a')).toBeUndefined();
    expect(db.query.mock.calls[0][0]).toContain('c.tenant_id = $1 AND c.id = $2');
    expect(db.query.mock.calls[0][1]).toEqual(['tenant-b', 'campaign-a']);
  });
});
