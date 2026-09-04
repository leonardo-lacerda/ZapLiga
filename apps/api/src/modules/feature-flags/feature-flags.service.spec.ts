import { FeatureFlagsService } from './feature-flags.service';

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
});
