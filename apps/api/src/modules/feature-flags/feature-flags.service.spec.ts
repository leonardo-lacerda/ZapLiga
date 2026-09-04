import { FeatureFlagsService, TENANT_FEATURES } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  it('defaults launch features to enabled and supports audited disablement', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);

    expect((await service.get('tenant-1')).callbacks).toBe(true);
    const updated = await service.update('tenant-1', { callbacks: false }, 'leader-1');

    expect(updated.callbacks).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.feature_flags_updated', metadata: { changed: ['callbacks'] } }));
  });

  it('ignores unset optional DTO fields instead of nulling out other flags', async () => {
    // class-validator DTOs declare every flag as an own property; an unset
    // flag still arrives here as `undefined`, not absent from the object.
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);
    const dtoLikeUpdate = Object.fromEntries(TENANT_FEATURES.map((feature) => [feature, undefined])) as Partial<Record<(typeof TENANT_FEATURES)[number], boolean>>;
    dtoLikeUpdate.callbacks = false;

    const updated = await service.update('tenant-1', dtoLikeUpdate, 'leader-1');

    expect(updated.callbacks).toBe(false);
    expect(updated.schedule_enforcement).toBe(true);
    expect(updated.privacy_requests).toBe(true);
    expect(updated.onboarding).toBe(true);
    expect(db.query.mock.calls[1][1]).not.toContain(undefined);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ metadata: { changed: ['callbacks'] } }));
  });
});
