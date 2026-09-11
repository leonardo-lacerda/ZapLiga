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

describe('MembershipsService access removal', () => {
  it('keeps the global session when another tenant is still active', async () => {
    const client = { query: jest.fn(async (sql: string) => sql.startsWith('UPDATE tenant_memberships') ? { rows: [{ status: 'blocked' }] } : { rows: [{ count: 1 }] }) };
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ role: 'sdr', status: 'active' }] }), transaction: jest.fn(async (callback: any) => callback(client)) };
    const service = new MembershipsService(db as any);
    await service.setStatus('tenant-a', 'user-1', 'blocked');
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE user_sessions'))).toBe(false);
  });

  it('revokes sessions immediately when the user has no tenant left', async () => {
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE tenant_memberships')) return { rows: [{ status: 'removed' }] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    }) };
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ role: 'sdr', status: 'active' }] }), transaction: jest.fn(async (callback: any) => callback(client)) };
    const service = new MembershipsService(db as any);
    await service.setStatus('tenant-a', 'user-1', 'removed');
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE user_sessions'))).toBe(true);
  });
});

describe('MembershipsService role promotion', () => {
  it('cria o perfil operacional ao promover um membro ativo para SDR', async () => {
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT count(*)')) return { rows: [{ count: 2 }] };
        if (sql.startsWith('UPDATE tenant_memberships')) return { rows: [{ role: 'sdr', status: 'active' }] };
        if (sql.startsWith('SELECT id FROM sdrs')) return { rows: [] };
        if (sql.startsWith('SELECT name FROM users')) return { rows: [{ name: 'Ana' }] };
        if (sql.startsWith('INSERT INTO sdrs')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const db = {
      query: jest.fn(async (sql: string) => sql.includes('SELECT count(*)')
        ? { rows: [{ count: 2 }] }
        : { rows: [{ role: 'leader', status: 'active' }] }),
      transaction: jest.fn(async (callback: any) => callback(client)),
    };
    const service = new MembershipsService(db as any);

    await service.setRole('tenant-a', 'user-1', 'sdr');

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sdrs'), [expect.any(String), 'tenant-a', 'user-1', 'Ana']);
  });
});
