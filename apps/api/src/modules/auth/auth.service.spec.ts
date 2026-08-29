import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { AuthService } from './auth.service';

const request = { headers: { cookie: 'zapcall_refresh=old-token' }, ip: '127.0.0.1' } as any;

const buildService = (current: any) => {
  const client = { query: jest.fn()
    .mockResolvedValueOnce({ rows: [current] })
    .mockResolvedValueOnce({ rows: [] }) };
  const db = {
    transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(client)),
    query: jest.fn(),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const users = {};
  const redis = {};
  return { service: new AuthService(db as any, jwt as any, users as any, audit as any, redis as any), client, db, audit };
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-old',
  user_id: 'user-1',
  family_id: 'family-1',
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  revoked_at: new Date(Date.now() - 5_000).toISOString(),
  replaced_by_session_id: 'session-new',
  replacement_revoked_at: null,
  rotation_grace_until: new Date(Date.now() + 55_000).toISOString(),
  name: 'User',
  email: 'user@example.com',
  platform_role: 'user',
  user_status: 'active',
  user_created_at: new Date().toISOString(),
  last_login_at: null,
  ...overrides,
});

describe('AuthService refresh rotation', () => {
  it('accepts a duplicated refresh during the short concurrent-rotation window', async () => {
    const { service, client, audit } = buildService(session());

    const result = await service.refresh(request);

    expect(result.accessToken).toBe('access-token');
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('WHERE family_id'))).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.refresh_concurrent' }));
  });

  it('revokes the family when a revoked refresh is used outside the grace window', async () => {
    const { service, client } = buildService(session({
      revoked_at: new Date(Date.now() - 180_000).toISOString(),
      rotation_grace_until: new Date(Date.now() - 120_000).toISOString(),
    }));

    await expect(service.refresh(request)).rejects.toMatchObject({ status: 401 });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain('WHERE family_id');
  });

  it('does not accept a token from a logged-out replacement session', async () => {
    const { service, client } = buildService(session({ replacement_revoked_at: new Date().toISOString() }));

    await expect(service.refresh(request)).rejects.toMatchObject({ status: 401 });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain('WHERE family_id');
  });
});
