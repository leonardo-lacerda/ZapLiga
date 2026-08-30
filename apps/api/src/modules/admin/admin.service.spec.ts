import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const query = jest.fn();
  const ping = jest.fn();
  const service = new AdminService({ query } as any, { client: { ping } } as any, {} as any);

  beforeEach(() => { query.mockReset(); ping.mockReset(); });

  it('aplica paginação segura na listagem de empresas', async () => {
    query.mockResolvedValueOnce({ rows: [{ total: 1 }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'tenant-1', name: 'Empresa' }] });

    const result = await service.listTenants({ search: 'Emp', status: 'active', limit: 9999, offset: -5 });

    expect(result).toEqual(expect.objectContaining({ total: 1, limit: 200, offset: 0 }));
    expect(query.mock.calls[0][1]).toEqual(['%Emp%', 'active']);
    expect(query.mock.calls[1][1]).toEqual(['%Emp%', 'active', 200, 0]);
  });

  it('revoga somente sessões ainda ativas do usuário', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'user-1' }] });
    query.mockResolvedValueOnce({ rows: [{ id: 'session-1' }], rowCount: 1 });

    await expect(service.revokeUserSessions('user-1')).resolves.toEqual({ ok: true, revoked: 1 });
    expect(query.mock.calls[1][0]).toContain('revoked_at IS NULL');
  });

  it('recusa revogação para empresa inexistente', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(service.revokeTenantSessions('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reporta banco e Redis indisponíveis sem derrubar o endpoint de saúde', async () => {
    query.mockRejectedValue(new Error('database down'));
    ping.mockRejectedValue(new Error('redis down'));

    const result = await service.health();

    expect(result.ok).toBe(false);
    expect(result.services.database.ok).toBe(false);
    expect(result.services.redis.ok).toBe(false);
  });
});
