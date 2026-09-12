import { PlanLimitsService } from './plan-limits.service';

describe('PlanLimitsService', () => {
  const access = { mode: 'full', reason: 'active_subscription', limitEntitlements: { numbers: 3, leads: 25, max_concurrent_dialers: 1 } } as any;
  const make = (rows: any[]) => {
    const db = { query: jest.fn().mockImplementation(async (sql: string) => ({ rows: sql.includes('limit_entitlements') ? [{ limit_entitlements: access.limitEntitlements }] : sql.includes('whatsapp_numbers') ? [{ count: 2 }] : sql.includes('FROM leads') ? [{ count: 24 }] : sql.includes('calls') ? [{ count: 1 }] : [{ max_leads: 100000 }] })) };
    const entitlement = { getAccess: jest.fn().mockResolvedValue(access), acquireTenantLock: jest.fn().mockResolvedValue(undefined), enforcementMode: 'enforce' };
    return { service: new PlanLimitsService(db as any, entitlement as any), db, entitlement };
  };

  it('does not cap customer-owned numbers while still enforcing the lead limit', async () => {
    const { service } = make([]);
    await expect(service.assertCanAddNumbers('tenant-1', undefined, 1)).resolves.toMatchObject({ used: 2, limit: null, available: null });
    await expect(service.assertCanAddLeads('tenant-1', undefined, 2)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'lead_limit_reached', limit: 25 }) });
  });

  it('does not cap concurrent reservations at a plan-level dialer limit', async () => {
    const { service } = make([]);
    await expect(service.assertCanReserveCall('tenant-1')).resolves.toMatchObject({ used: 1, limit: null, available: null });
  });

  it('does not allow capacity mutations while the organization is read-only', async () => {
    const { service, entitlement } = make([]);
    entitlement.getAccess.mockResolvedValue({ mode: 'read_only', reason: 'past_due', limitEntitlements: {} });
    await expect(service.assertCanAddLeads('tenant-1')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'subscription_required' }) });
  });
});
