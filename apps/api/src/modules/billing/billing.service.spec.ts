import { BillingService } from './billing.service';

describe('BillingService subscription projection', () => {
  it('uses the requested seat quantity when previewing a plan change', async () => {
    const db = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT ts.id, ts.stripe_subscription_id')) return Promise.resolve({ rows: [{ id: 'sub-row', stripe_subscription_id: 'sub-1', current_period_end: new Date(Date.now() + 86_400_000), sort_order: 1, billing_interval: 'month' }] });
        if (sql.includes('SELECT pp.*')) return Promise.resolve({ rows: [{ plan_version_id: 'plan-growth-v1', code: 'growth', display_name: 'Growth', max_sdrs: 5, included_sdrs: 5, sort_order: 2, billing_interval: 'month', stripe_price_id: 'price-growth', unit_amount: 24990, currency: 'brl', limit_entitlements: { leads: 250000, retention_days: 365 } }] });
        if (sql.includes('SELECT count(*)::int AS leads')) return Promise.resolve({ rows: [{ leads: 0 }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    const entitlement = { getAccess: jest.fn().mockResolvedValue({ planCode: 'starter', includedSdrs: 2, maxSdrs: 2, purchasedExtraSdrs: 0, usedSdrSeats: 2, reservedSdrSeats: 0 }) };
    const service = new BillingService(db as any, { livemode: false } as any, entitlement as any, {} as any);

    await expect(service.previewPlanChange('tenant-1', 'growth', 'month', 5)).resolves.toMatchObject({ currentTotalSeats: 2, targetTotalSeats: 5, extraSeats: 0 });
    await expect(service.previewPlanChange('tenant-1', 'growth', 'month', 6)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'seat_cap_exceeded' }) });
  });

  it('blocks seats above the new plan commercial cap', async () => {
    const entitlement = {
      getAccess: jest.fn().mockResolvedValue({
        includedSdrs: 2, maxSdrs: 2, planMaxSdrs: 2, purchasedExtraSdrs: 0,
        usedSdrSeats: 2, reservedSdrSeats: 0,
      }),
    };
    const service = new BillingService({} as any, {} as any, entitlement as any, {} as any);

    await expect(service.previewSeatChange('tenant-1', 2)).resolves.toMatchObject({ targetTotalSeats: 2, extraSeats: 0 });
    await expect(service.previewSeatChange('tenant-1', 3)).rejects.toMatchObject({ response: expect.objectContaining({ message: expect.stringContaining('2') }) });
  });

  it('previews an administrative checkout when the tenant has no subscription', async () => {
    const db = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM tenant_subscriptions ts')) return Promise.resolve({ rows: [] });
        if (sql.includes('SELECT pp.*')) return Promise.resolve({ rows: [{ plan_version_id: 'plan-starter-v1', code: 'starter', display_name: 'Starter', max_sdrs: 2, included_sdrs: 2, sort_order: 1, billing_interval: 'month', stripe_price_id: 'price-starter', unit_amount: 8990, currency: 'brl', limit_entitlements: {} }] });
        if (sql.includes('FROM billing_addon_prices')) return Promise.resolve({ rows: [{ stripe_price_id: 'price-seat', unit_amount: 1990, currency: 'brl' }] });
        return Promise.resolve({ rows: [] });
      }),
    };
    const service = new BillingService(db as any, { livemode: false } as any, {} as any, {} as any);

    await expect(service.previewAdminChange('tenant-1', 'starter', 'month', 2)).resolves.toMatchObject({
      mode: 'checkout', targetPlanCode: 'starter', targetTotalSeats: 2, extraSeats: 0, price: { amount: 8990, baseAmount: 8990, seatAmount: 0 },
    });
  });

  it('clears the local access_until when Stripe deletes a subscription', async () => {
    const dbQuery = jest.fn().mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-row', access_until: new Date(Date.now() + 86_400_000), stripe_price_id: 'price_base', plan_version_id: 'plan_starter_v1' }] });
    let insertSql = '';
    let insertParams: unknown[] = [];
    const client = {
      query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO tenant_subscriptions')) { insertSql = sql; insertParams = params ?? []; }
        return { rows: [] };
      }),
    };
    const db = { query: dbQuery, transaction: jest.fn(async (callback: (executor: typeof client) => Promise<unknown>) => callback(client)) };
    const entitlement = {
      getAccess: jest.fn()
        .mockResolvedValueOnce({ mode: 'full', featureEntitlements: {}, limitEntitlements: {} })
        .mockResolvedValueOnce({ mode: 'read_only', featureEntitlements: {}, limitEntitlements: {} }),
      recompute: jest.fn().mockResolvedValue(undefined),
    };
    const stripe = { livemode: false, configured: true };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BillingService(db as any, stripe as any, entitlement as any, audit as any);

    await (service as any).syncSubscription({
      id: 'sub_1', customer: 'cus_1', status: 'canceled',
      current_period_start: 1_700_000_000, current_period_end: 1_700_086_400,
      trial_end: null, cancel_at_period_end: false, canceled_at: 1_700_000_100,
      ended_at: 1_700_000_100, latest_invoice: 'in_1', items: { data: [] },
    }, { id: 'evt_deleted', type: 'customer.subscription.deleted', created: 1_700_000_200 }, false);

    expect(insertSql).toContain('access_until = CASE WHEN EXCLUDED.ended_at IS NOT NULL THEN NULL');
    expect(insertParams[16]).toBeNull();
    expect(entitlement.recompute).toHaveBeenCalledWith('tenant-1', client);
  });

  it('does not count a newly added seat before invoice.paid', async () => {
    const dbQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1' }] })
      .mockResolvedValueOnce({ rows: [{ stripe_price_id: 'price_base' }] })
      .mockResolvedValueOnce({ rows: [{ plan_version_id: 'plan_starter_v1', code: 'starter', display_name: 'Starter', max_sdrs: 2, included_sdrs: 2, feature_entitlements: {}, limit_entitlements: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-row', access_until: new Date(Date.now() + 86_400_000), stripe_price_id: 'price_base', plan_version_id: 'plan_starter_v1' }] });
    let itemInsertSql = '';
    const client = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM billing_addon_prices')) return { rows: [{ id: 'addon-row' }] };
        if (sql.includes('INSERT INTO tenant_subscription_items')) itemInsertSql = sql;
        return { rows: [] };
      }),
    };
    const db = { query: dbQuery, transaction: jest.fn(async (callback: (executor: typeof client) => Promise<unknown>) => callback(client)) };
    const entitlement = {
      getAccess: jest.fn()
        .mockResolvedValueOnce({ mode: 'full', featureEntitlements: {}, limitEntitlements: {} })
        .mockResolvedValueOnce({ mode: 'full', featureEntitlements: {}, limitEntitlements: {} }),
      recompute: jest.fn().mockResolvedValue(undefined),
    };
    const service = new BillingService(db as any, { livemode: false, configured: true } as any, entitlement as any, { record: jest.fn().mockResolvedValue(undefined) } as any);

    await (service as any).syncSubscription({
      id: 'sub_1', customer: 'cus_1', status: 'active', current_period_start: 1_700_000_000,
      current_period_end: 1_700_086_400, trial_end: null, cancel_at_period_end: false,
      canceled_at: null, ended_at: null, latest_invoice: 'in_1',
      items: { data: [{ id: 'si_base', price: { id: 'price_base' }, quantity: 1 }, { id: 'si_seat', price: { id: 'price_seat' }, quantity: 2 }] },
    }, { id: 'evt_updated', type: 'customer.subscription.updated', created: 1_700_000_200 }, false);

    expect(itemInsertSql).toContain("CASE WHEN $11::boolean OR $5 <> 'sdr_seat' THEN $8 ELSE 0 END");
  });
});
