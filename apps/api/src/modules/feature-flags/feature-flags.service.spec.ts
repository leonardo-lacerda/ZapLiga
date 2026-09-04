import { defaultTenantFeatureFlags, FeatureFlagsService, TENANT_FEATURES } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  it('defaults launch features to enabled and supports audited disablement', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) };
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
    expect(db.query.mock.calls[2][0]).toContain('campaigns=EXCLUDED.campaigns');
    expect(db.query.mock.calls[2][1]).toEqual([
      'tenant-1',
      ...TENANT_FEATURES.map((feature) => feature === 'callbacks' ? false : defaultTenantFeatureFlags()[feature]),
      'leader-1',
    ]);
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

  it('ignores undefined optional DTO fields when updating flags', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);
    const dtoLikeUpdate = Object.fromEntries(TENANT_FEATURES.map((feature) => [feature, undefined])) as Partial<Record<(typeof TENANT_FEATURES)[number], boolean>>;
    dtoLikeUpdate.callbacks = false;

    const updated = await service.update('tenant-1', dtoLikeUpdate, 'leader-1');

    expect(updated.callbacks).toBe(false);
    expect(updated.schedule_enforcement).toBe(true);
    expect(updated.campaigns).toBe(false);
    expect(db.query.mock.calls[1][1]).not.toContain(undefined);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: { changed: ['callbacks'] } }));
  });
});
