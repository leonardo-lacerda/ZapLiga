import { ConflictException } from '@nestjs/common';
import { MembershipsService } from './memberships.service';

describe('MembershipsService.create', () => {
  const makeService = (queryImpl: (sql: string, params?: unknown[]) => Promise<any>) => {
    const client = { query: jest.fn(queryImpl) };
    const db = { transaction: jest.fn((fn: (client: any) => Promise<any>) => fn(client)) };
    return { service: new MembershipsService(db as any), client };
  };

  it('cria uma nova membership quando não existe vínculo prévio', async () => {
    const { service, client } = makeService(async (sql: string) => {
      if (sql.includes('SELECT * FROM tenant_memberships')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tenant_memberships')) return { rows: [{ id: 'membership-1', role: 'leader' }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.create('tenant-1', 'user-1', 'leader');

    expect(result).toEqual({ id: 'membership-1', role: 'leader' });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('rejeita quando o usuário já possui membership ativa nesta empresa', async () => {
    const { service } = makeService(async (sql: string) => {
      if (sql.includes('SELECT * FROM tenant_memberships')) return { rows: [{ id: 'membership-1', status: 'active' }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(service.create('tenant-1', 'user-1', 'leader')).rejects.toBeInstanceOf(ConflictException);
  });

  it('reativa uma membership removida em vez de tentar inserir uma nova', async () => {
    const { service, client } = makeService(async (sql: string) => {
      if (sql.includes('SELECT * FROM tenant_memberships')) return { rows: [{ id: 'membership-1', status: 'removed' }] };
      if (sql.startsWith('UPDATE tenant_memberships')) return { rows: [{ id: 'membership-1', role: 'leader', status: 'active' }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await service.create('tenant-1', 'user-1', 'leader');

    expect(result.status).toBe('active');
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toMatch(/^UPDATE tenant_memberships/);
  });

  it('cria a linha em sdrs quando o papel é sdr e há quota disponível', async () => {
    const { service, client } = makeService(async (sql: string) => {
      if (sql.includes('SELECT * FROM tenant_memberships')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tenant_memberships')) return { rows: [{ id: 'membership-1', role: 'sdr' }] };
      if (sql.startsWith('SELECT id FROM sdrs')) return { rows: [] };
      if (sql.includes('max_sdrs')) return { rows: [{ max_sdrs: 5, current: 1 }] };
      if (sql.startsWith('SELECT name FROM users')) return { rows: [{ name: 'Ana' }] };
      if (sql.startsWith('INSERT INTO sdrs')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await service.create('tenant-1', 'user-1', 'sdr');

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sdrs'), [expect.any(String), 'tenant-1', 'user-1', 'Ana']);
  });

  it('rejeita a criação de sdr quando a quota da empresa já foi atingida', async () => {
    const { service } = makeService(async (sql: string) => {
      if (sql.includes('SELECT * FROM tenant_memberships')) return { rows: [] };
      if (sql.startsWith('INSERT INTO tenant_memberships')) return { rows: [{ id: 'membership-1', role: 'sdr' }] };
      if (sql.startsWith('SELECT id FROM sdrs')) return { rows: [] };
      if (sql.includes('max_sdrs')) return { rows: [{ max_sdrs: 1, current: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(service.create('tenant-1', 'user-1', 'sdr')).rejects.toBeInstanceOf(ConflictException);
  });
});
