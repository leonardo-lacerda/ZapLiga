import 'reflect-metadata';
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));
import { Reflector } from '@nestjs/core';
import { AuthGuard, ROLES_KEY, RolesGuard, TenantMembershipGuard } from './auth.guards';

const contextFor = (request: any, handler = () => undefined, target = class TestController {}) => ({
  switchToHttp: () => ({ getRequest: () => request }),
  getHandler: () => handler,
  getClass: () => target,
} as any);

describe('auth and tenant guards', () => {
  it('rejects requests without a bearer token', async () => {
    const guard = new AuthGuard({ verifyAccessToken: jest.fn() } as any, { query: jest.fn() } as any);
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toMatchObject({ status: 401 });
  });

  it('loads the current user from a valid access token', async () => {
    const request: any = { headers: { authorization: 'Bearer valid' } };
    const auth = { verifyAccessToken: jest.fn().mockResolvedValue({ sub: 'user-1', sid: 'session-1' }) };
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'user-1', platform_role: 'user', status: 'active', email_verified_at: new Date().toISOString(), pending_legal_count: 0, force_password_change: false }] }) };
    await expect(new AuthGuard(auth as any, db as any).canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: 'user-1', platformRole: 'user', sessionId: 'session-1' });
  });

  it('rejects a revoked session immediately and increments the operational counter', async () => {
    const auth = { verifyAccessToken: jest.fn().mockResolvedValue({ sub: 'user-1', sid: 'revoked-1' }) };
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const redis = { incrementMetric: jest.fn().mockResolvedValue(undefined) };
    await expect(new AuthGuard(auth as any, db as any, redis as any).canActivate(contextFor({ headers: { authorization: 'Bearer valid' } }))).rejects.toMatchObject({ status: 401 });
    expect(redis.incrementMetric).toHaveBeenCalledWith('revoked_session_access_total');
  });

  it('accepts only an active membership for the selected tenant', async () => {
    const request: any = { headers: { 'x-tenant-id': 'tenant-a' }, user: { id: 'user-1', platformRole: 'user', tenantMembership: undefined } };
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'tenant-a', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-a', role: 'sdr', status: 'active', tenant_status: 'active' }] }) };
    await expect(new TenantMembershipGuard(db as any, { record: jest.fn() } as any, { client: { set: jest.fn().mockResolvedValue('OK') } } as any).canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
    expect(request.user.tenantMembership.role).toBe('sdr');
  });

  it('allows a super admin only when the requested role includes super_admin', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(ROLES_KEY, ['super_admin'], handler);
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor({ user: { platformRole: 'super_admin' } }, handler))).toBe(true);
  });
});
