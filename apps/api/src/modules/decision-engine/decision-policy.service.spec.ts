import { DecisionPolicyService } from './decision-policy.service';

const activePolicy = {
  id: 'policy-1',
  version: 1,
  mode: 'active',
  weights: { baseScore: 500, priorityWeight: 4, recentInboundWeight: 180, ageWeight: 120, callbackDueWeight: 300, attemptsPenalty: 50, fairnessWeight: 100, recentInboundHours: 24, ageHorizonHours: 72 },
};

const row = (id: string, queuePriority: number, queuedAt: string, queueSequence: number) => ({
  id, campaign_id: 'campaign-1', queue_priority: queuePriority, attempts: 0, created_at: queuedAt, queued_at: queuedAt,
  source_integration_id: null, queue_sequence: queueSequence, next_eligible_at: '2026-09-04T12:00:00.000Z',
});

describe('active decision ordering', () => {
  it('reorders only active campaign slots and preserves shadow candidates', async () => {
    const service = Object.create(DecisionPolicyService.prototype) as any;
    service.getPolicy = jest.fn().mockResolvedValue(activePolicy);
    service.incrementMetric = jest.fn();
    service.observeMetric = jest.fn();
    const candidates = [row('old', 0, '2026-09-04T10:00:00.000Z', 1), row('new', 100, '2026-09-04T11:59:00.000Z', 2)];

    const result = await service.prioritizeCandidates('tenant-1', candidates);

    expect(result.rows.map((item: any) => item.id)).toEqual(['new', 'old']);
    expect(result.contexts.get('new')).toEqual(expect.objectContaining({ policyVersion: 1, fifoPosition: 2, suggestedPosition: 1 }));
  });

  it('keeps disabled and shadow campaigns in their configured order', async () => {
    const service = Object.create(DecisionPolicyService.prototype) as any;
    service.getPolicy = jest.fn().mockResolvedValue({ ...activePolicy, mode: 'shadow' });
    service.incrementMetric = jest.fn();
    service.observeMetric = jest.fn();
    const candidates = [row('first', 0, '2026-09-04T11:00:00.000Z', 1), row('second', 100, '2026-09-04T11:59:00.000Z', 2)];

    const result = await service.prioritizeCandidates('tenant-1', candidates);

    expect(result.rows.map((item: any) => item.id)).toEqual(['first', 'second']);
    expect(result.contexts.size).toBe(0);
  });

  it('protects a long-waiting lead from starvation even with a lower score', async () => {
    const service = Object.create(DecisionPolicyService.prototype) as any;
    service.getPolicy = jest.fn().mockResolvedValue(activePolicy);
    service.incrementMetric = jest.fn();
    service.observeMetric = jest.fn();
    const candidates = [row('fresh-high', 100, '2026-09-04T11:59:00.000Z', 1), row('waiting', 0, '2026-09-03T00:00:00.000Z', 2)];

    const result = await service.prioritizeCandidates('tenant-1', candidates);

    expect(result.rows[0].id).toBe('waiting');
    expect(result.contexts.get('waiting')?.starvationProtected).toBe(true);
  });

  it('falls back to the configured order when policy evaluation fails', async () => {
    const service = Object.create(DecisionPolicyService.prototype) as any;
    service.getPolicy = jest.fn().mockRejectedValue(new Error('policy unavailable'));
    service.incrementMetric = jest.fn();
    service.observeMetric = jest.fn();
    const candidates = [row('first', 0, '2026-09-04T11:00:00.000Z', 1), row('second', 100, '2026-09-04T11:59:00.000Z', 2)];

    const result = await service.prioritizeCandidates('tenant-1', candidates);

    expect(result.rows.map((item: any) => item.id)).toEqual(['first', 'second']);
    expect(result.contexts.size).toBe(0);
    expect(service.incrementMetric).toHaveBeenCalledWith('active_fallback_total');
  });
});
