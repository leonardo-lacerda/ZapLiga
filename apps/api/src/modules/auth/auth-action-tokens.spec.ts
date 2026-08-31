import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { AuthService } from './auth.service';

const build = (purpose: 'reset_password' | 'verify_email', expiresAt = new Date(Date.now() + 60_000)) => {
  let consumed = false;
  const action = { id: 'action-1', user_id: 'user-1', purpose, expires_at: expiresAt.toISOString(), consumed_at: null, email: 'user@example.com', name: 'User' };
  const client = { query: jest.fn(async (sql: string) => {
    if (sql.includes('FROM user_action_tokens')) return { rows: consumed ? [{ ...action, consumed_at: new Date().toISOString() }] : [action] };
    if (sql.includes('UPDATE user_action_tokens SET consumed_at')) consumed = true;
    return { rows: [] };
  }) };
  const db = { transaction: jest.fn(async (callback: any) => callback(client)), query: jest.fn() };
  const redis = { client: { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) }, incrementMetric: jest.fn().mockResolvedValue(undefined) };
  const users = { hashPassword: jest.fn().mockResolvedValue('hash') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mailer = { passwordChanged: jest.fn().mockResolvedValue(undefined) };
  return { service: new AuthService(db as any, {} as any, users as any, audit as any, redis as any, mailer as any), client, redis };
};

describe('single-use account action tokens', () => {
  it('locks, consumes and rejects reuse of a reset token', async () => {
    const { service, client, redis } = build('reset_password');
    await expect(service.resetPassword('a'.repeat(48), 'Changed!23456')).resolves.toEqual({ ok: true });
    await expect(service.resetPassword('a'.repeat(48), 'Changed!23456')).rejects.toMatchObject({ status: 400 });
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE OF t');
    expect(redis.incrementMetric).toHaveBeenCalledWith('action_token_failures_total');
  });

  it('rejects an expired token without changing the password', async () => {
    const { service, client } = build('reset_password', new Date(Date.now() - 1000));
    await expect(service.resetPassword('b'.repeat(48), 'Changed!23456')).rejects.toMatchObject({ status: 400 });
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE users SET password_hash'))).toBe(false);
  });

  it('makes email verification idempotent only at the account state, not at the token', async () => {
    const { service, client } = build('verify_email');
    await expect(service.verifyEmail('c'.repeat(48))).resolves.toEqual({ ok: true });
    await expect(service.verifyEmail('c'.repeat(48))).rejects.toMatchObject({ status: 400 });
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE');
  });
});
