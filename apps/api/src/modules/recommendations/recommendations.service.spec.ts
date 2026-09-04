import { ConflictException } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';

const buildService = (overrides: Record<string, any> = {}) => {
  const repo = { get: jest.fn(), recordEvent: jest.fn().mockResolvedValue({ id: 'event-1' }), updateStatus: jest.fn().mockResolvedValue(undefined), ...overrides.repo };
  const metrics = {};
  const flags = { assertEnabled: jest.fn().mockResolvedValue(undefined) };
  const db = { query: jest.fn(), transaction: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new RecommendationsService(repo as any, metrics as any, flags as any, db as any, audit as any, overrides.schedule), repo, flags, db, audit };
};

describe('RecommendationsService.apply', () => {
  it('is idempotent when the dialer is already running', async () => {
    const dialer = { start: jest.fn() };
    const { service, repo, db } = buildService({ dialer });
    repo.get.mockResolvedValue({ id: 'r-1', tenant_id: 'tenant-1', action_type: 'start_dialer', recommended_action: { type: 'start_dialer', payload: {} } });
    db.query
      .mockResolvedValueOnce({ rows: [{ running: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ running: true }] })
      .mockResolvedValueOnce({ rows: [{ running: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ running: true }] });

    const first = await service.apply('tenant-1', 'r-1', 'user-1');
    const second = await service.apply('tenant-1', 'r-1', 'user-1');

    expect(first.result).toEqual({ kind: 'no_op', reason: 'already_running' });
    expect(second.result).toEqual({ kind: 'no_op', reason: 'already_running' });
    expect(dialer.start).not.toHaveBeenCalled();
    expect(repo.recordEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects an action that is not in the closed catalog and records the failure', async () => {
    const { service, repo } = buildService();
    repo.get.mockResolvedValue({ id: 'r-1', tenant_id: 'tenant-1', action_type: 'run_arbitrary_method', recommended_action: { type: 'run_arbitrary_method', payload: { method: 'dropAll' } } });

    await expect(service.apply('tenant-1', 'r-1', 'user-1')).rejects.toBeInstanceOf(ConflictException);
    expect(repo.recordEvent).toHaveBeenCalledWith('tenant-1', 'r-1', 'failed', 'user-1', expect.objectContaining({ actionType: 'run_arbitrary_method' }));
  });
});
