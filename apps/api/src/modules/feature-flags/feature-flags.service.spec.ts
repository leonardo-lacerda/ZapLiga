import { defaultTenantFeatureFlags, FeatureFlagsService, TENANT_FEATURES } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  it('defaults launch features to enabled and supports audited disablement', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);

    expect(await service.get('tenant-1')).toEqual(defaultTenantFeatureFlags());
    expect(defaultTenantFeatureFlags()).toMatchObject({
      callbacks: true,
      onboarding: true,
      privacy_requests: true,
      schedule_enforcement: true,
      campaigns: false,
    });

    const updated = await service.update('tenant-1', { callbacks: false }, 'leader-1');

    expect(updated.callbacks).toBe(false);
    expect(updated.onboarding).toBe(true);
    expect(updated.campaigns).toBe(false);
    // Only the changed column is written -- writing every column from a stale snapshot is what
    // let concurrent toggles of different flags clobber each other (see update()'s comment).
    const flagsInsert = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO tenant_feature_flags'));
    expect(flagsInsert?.[0]).toContain('callbacks=EXCLUDED.callbacks');
    expect(flagsInsert?.[0]).not.toContain('campaigns');
    expect(flagsInsert?.[1]).toEqual(['tenant-1', false, 'leader-1']);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.feature_flags_updated', metadata: { changed: ['callbacks'] } }));
  });

  it('keeps every roadmap capability disabled when reading a legacy cache entry', async () => {
    const redis = { client: { get: jest.fn().mockResolvedValue(JSON.stringify({ callbacks: true })), set: jest.fn(), del: jest.fn() } };
    const service = new FeatureFlagsService({ query: jest.fn() } as any, redis as any, { record: jest.fn() } as any);

    const flags = await service.get('tenant-legacy');

    expect(flags.callbacks).toBe(true);
    expect(flags.campaigns).toBe(false);
    expect(flags.decision_engine).toBe(false);
    expect(flags.recommendations).toBe(false);
    expect(flags.operation_health).toBe(false);
    expect(flags.analytics_learning).toBe(false);
    expect(flags.experiments).toBe(false);
    expect(flags.benchmarks).toBe(false);
  });

  it('discards an oversized cache entry and only returns known boolean flags', async () => {
    const redis = { client: { get: jest.fn().mockResolvedValue('x'.repeat(4097)), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ callbacks: false, campaigns: true, unexpected: 'never expose this' }] }) };
    const service = new FeatureFlagsService(db as any, redis as any, { record: jest.fn() } as any);

    const flags = await service.get('tenant-corrupted');

    expect(redis.client.del).toHaveBeenCalledWith('zapcall:tenant:tenant-corrupted:feature-flags');
    // One query for the tenant's row, one for its active entitlement overrides.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(flags.callbacks).toBe(false);
    expect(flags.campaigns).toBe(true);
    expect(flags).not.toHaveProperty('unexpected');
    expect(Object.keys(flags)).toEqual(TENANT_FEATURES);
  });

  it('does not spread a cached primitive into an unbounded response object', async () => {
    const redis = { client: { get: jest.fn().mockResolvedValue(JSON.stringify('corrupted-cache-value')), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new FeatureFlagsService(db as any, redis as any, { record: jest.fn() } as any);

    const flags = await service.get('tenant-primitive-cache');

    expect(redis.client.del).toHaveBeenCalled();
    expect(flags).toEqual(defaultTenantFeatureFlags());
    expect(Object.keys(flags)).toEqual(TENANT_FEATURES);
  });

  it('ignores undefined optional DTO fields when updating flags', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);
    const dtoLikeUpdate = Object.fromEntries(TENANT_FEATURES.map((feature) => [feature, undefined])) as Partial<Record<(typeof TENANT_FEATURES)[number], boolean>>;
    dtoLikeUpdate.callbacks = false;

    const updated = await service.update('tenant-1', dtoLikeUpdate, 'leader-1');

    expect(updated.callbacks).toBe(false);
    expect(updated.schedule_enforcement).toBe(true);
    expect(updated.campaigns).toBe(false);
    const flagsInsert = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO tenant_feature_flags'));
    expect(flagsInsert?.[1]).not.toContain(undefined);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: { changed: ['callbacks'] } }));
  });

  it('nav visibility (get) needs an entitlement override to enable a roadmap feature on a manually-granted tenant', async () => {
    // Regression for a real production incident: a tenant given full access via a manual grant
    // (not a Stripe plan) gets `feature_entitlements = '{}'` (present but empty), which makes
    // `hasCommercialSnapshot` true and forces every roadmap feature to 'none' -- the legacy
    // "Recursos da empresa" admin toggle then silently has no effect. An active grant override
    // is the one thing that still turns the feature on, and `get()` (nav visibility) must honor
    // it exactly like `getLevels()` (API gating) already did -- before this fix it did not.
    const row = { access_mode: 'full', feature_entitlements: {}, last_active_feature_entitlements: {}, operational_flags: {} };
    const withoutOverride = { query: jest.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] }) };
    const service1 = new FeatureFlagsService(withoutOverride as any, { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn() } } as any, { record: jest.fn() } as any);
    expect((await service1.get('tenant-1')).campaigns).toBe(false);

    const withOverride = { query: jest.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ feature_code: 'campaigns', override_mode: 'grant', value: {} }] }) };
    const service2 = new FeatureFlagsService(withOverride as any, { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn() } } as any, { record: jest.fn() } as any);
    expect((await service2.get('tenant-1')).campaigns).toBe(true);
  });

  it('does not let concurrent toggles of different flags clobber each other', async () => {
    // Regression for the "select all, refresh, most reverted" bug: each update() used to read a
    // `current` snapshot and write ALL 12 columns from it. Two overlapping requests toggling
    // DIFFERENT flags would each write their target flag plus 11 stale values for the others --
    // whichever one's UPDATE committed last silently reverted every flag the other had just set.
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);

    // Simulates two toggles racing: both start from the same pre-update state, and their flags
    // inserts can land in either order -- neither write should mention the other's column.
    await Promise.all([
      service.update('tenant-1', { campaigns: true }, 'leader-1'),
      service.update('tenant-1', { experiments: true }, 'leader-1'),
    ]);

    const flagInserts = db.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO tenant_feature_flags'));
    expect(flagInserts).toHaveLength(2);
    for (const [sql] of flagInserts) {
      // Each write touches exactly one boolean column, never the other request's flag.
      const matches = String(sql).match(/\b(campaigns|experiments)\b/g) ?? [];
      expect(new Set(matches).size).toBe(1);
    }
  });

  it('treats plan entitlements as commercial access and keeps expired tenants read-only', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ access_mode: 'read_only', access_until: new Date(Date.now() - 1000), feature_entitlements: { campaigns: 'full' }, last_active_feature_entitlements: { campaigns: 'full' }, operational_flags: {} }] }) };
    const service = new FeatureFlagsService(db as any, { client: { get: jest.fn(), set: jest.fn(), del: jest.fn() } } as any, { record: jest.fn() } as any);
    await expect(service.assertEnabled('tenant-1', 'campaigns', 'POST')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'feature_disabled', level: 'read_only' }) });
    await expect(service.assertEnabled('tenant-1', 'campaigns', 'GET')).resolves.toBeUndefined();
  });

  it('does not let the legacy admin flag grant a feature excluded by an active plan', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ access_mode: 'full', access_until: new Date(Date.now() + 60_000), feature_entitlements: { campaigns: 'none' }, last_active_feature_entitlements: {}, operational_flags: {} }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const service = new FeatureFlagsService(db as any, { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() } } as any, { record: jest.fn() } as any);

    await expect(service.assertEnabled('tenant-1', 'campaigns', 'POST')).rejects.toMatchObject({ response: expect.objectContaining({ code: 'feature_disabled', level: 'none' }) });
  });
});
