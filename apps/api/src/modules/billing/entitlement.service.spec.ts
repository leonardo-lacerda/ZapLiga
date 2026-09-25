import { EntitlementService } from './entitlement.service';
import { SdrCapacityService } from './sdr-capacity.service';

describe('billing entitlement enforcement', () => {
  const originalMode = process.env.BILLING_ENFORCEMENT_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.BILLING_ENFORCEMENT_MODE;
    else process.env.BILLING_ENFORCEMENT_MODE = originalMode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  const makeEntitlement = (row: any) => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    const redis = { client: { del: jest.fn().mockResolvedValue(1) }, incrementMetric: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    return { service: new EntitlementService(db as any, redis as any, audit as any), db, redis, audit };
  };

  it('downgrades an expired projected entitlement to read-only', async () => {
    const { service } = makeEntitlement({
      tenant_status: 'active', access_mode: 'full', access_reason: 'active_subscription',
      access_until: new Date(Date.now() - 1_000), max_sdrs: 10, source: 'stripe',
      plan_code: 'pro', plan_name: 'Pro', used_sdr_seats: 2, reserved_sdr_seats: 1,
    });
    const access = await service.getAccess('tenant-1');
    expect(access.mode).toBe('read_only');
    expect(access.reason).toBe('subscription_expired');
  });

  it('returns a consistent 402 for writes without an active plan', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = 'enforce';
    const { service, audit } = makeEntitlement({ tenant_status: 'active', access_mode: 'read_only', access_reason: 'past_due' });
    await expect(service.assertAction('tenant-1', 'write', 'user-1')).rejects.toMatchObject({
      status: 402,
      response: expect.objectContaining({ code: 'subscription_required', billingReason: 'past_due' }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.action_denied', tenantId: 'tenant-1' }));
  });

  it('lets a super admin with edit mode on write to a read-only tenant, but not a regular user', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = 'enforce';
    const db = { query: jest.fn(async (sql: string) => ({ rows: [sql.includes('platform_role') ? { platform_role: 'super_admin' } : { tenant_status: 'active', access_mode: 'read_only', access_reason: 'no_subscription' }] })) };
    const redis = { client: { get: jest.fn().mockResolvedValue('1'), del: jest.fn() }, incrementMetric: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new EntitlementService(db as any, redis as any, audit as any);
    await expect(service.assertAction('tenant-1', 'write', 'admin-1')).resolves.toMatchObject({ mode: 'read_only' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.admin_write_override', tenantId: 'tenant-1' }));
    redis.client.get.mockResolvedValue(null);
    await expect(service.assertAction('tenant-1', 'write', 'user-1')).rejects.toMatchObject({ status: 402 });
  });

  it('defaults to enforce in production when the mode is blank', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = '  ';
    const { service } = makeEntitlement({ tenant_status: 'active', access_mode: 'read_only', access_reason: 'no_subscription' });
    await expect(service.assertAction('tenant-1', 'write', 'user-1')).rejects.toMatchObject({ status: 402 });
  });

  it('defaults to off outside production when the mode is blank', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BILLING_ENFORCEMENT_MODE = '';
    const { service } = makeEntitlement({ tenant_status: 'active', access_mode: 'read_only', access_reason: 'no_subscription' });
    await expect(service.assertAction('tenant-1', 'write', 'user-1')).resolves.toMatchObject({ mode: 'read_only' });
  });

  it('fails closed when NODE_ENV is missing and the mode is blank', async () => {
    delete process.env.NODE_ENV;
    process.env.BILLING_ENFORCEMENT_MODE = '';
    const { service } = makeEntitlement({ tenant_status: 'active', access_mode: 'read_only', access_reason: 'no_subscription' });
    await expect(service.assertAction('tenant-1', 'write', 'user-1')).rejects.toMatchObject({ status: 402 });
  });

  it('allows finalizing an existing call in read-only but denies an administratively blocked tenant', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = 'enforce';
    const readOnly = makeEntitlement({ tenant_status: 'active', access_mode: 'read_only', access_reason: 'no_subscription' }).service;
    await expect(readOnly.assertAction('tenant-1', 'call_finalize')).resolves.toMatchObject({ mode: 'read_only' });
    const blocked = makeEntitlement({ tenant_status: 'blocked', access_mode: 'read_only', access_reason: 'tenant_blocked' }).service;
    await expect(blocked.assertAction('tenant-1', 'call_finalize')).rejects.toMatchObject({ status: 403 });
  });

  it('does not let an expired entitlement reserve a new SDR seat', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENFORCEMENT_MODE = 'enforce';
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ tenant_status: 'active', access_mode: 'full', access_until: new Date(Date.now() - 1_000), access_reason: 'active_subscription', max_sdrs: 10, used: 0, reserved: 0 }] }),
    };
    const entitlement = makeEntitlement({ tenant_status: 'active', access_mode: 'full' }).service;
    const capacity = new SdrCapacityService(db as any, entitlement);
    await expect(capacity.assertCanAdd('tenant-1', db as any)).rejects.toMatchObject({ status: 402 });
  });
});
