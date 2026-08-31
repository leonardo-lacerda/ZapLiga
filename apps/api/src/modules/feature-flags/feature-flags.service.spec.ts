import { FeatureFlagsService } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  it('defaults safely to disabled before rollout and supports audited enablement', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) };
    const redis = { client: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new FeatureFlagsService(db as any, redis as any, audit as any);

    expect((await service.get('tenant-1')).callbacks).toBe(false);
    const updated = await service.update('tenant-1', { callbacks: true }, 'leader-1');

    expect(updated.callbacks).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'tenant.feature_flags_updated', metadata: { changed: ['callbacks'] } }));
  });
});
