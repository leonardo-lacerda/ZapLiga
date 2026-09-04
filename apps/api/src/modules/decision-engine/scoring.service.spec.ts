import { compareScoredLeads, normalizeScorePolicy, scoreLead } from './scoring.service';

const now = new Date('2026-09-04T12:00:00.000Z');

describe('deterministic lead scoring', () => {
  it('returns the same score and explanation for the same snapshot', () => {
    const input = {
      lead: { id: 'lead-1', queuePriority: 8, attempts: 1, createdAt: '2026-09-04T06:00:00.000Z', source: 'inbound' },
      callbackDueAt: '2026-09-04T11:30:00.000Z',
      fairnessBoost: 0.25,
      now,
      policyVersion: 3,
    };
    expect(scoreLead(input)).toEqual(scoreLead(input));
  });

  it('makes the main business signals visible in the reason effects', () => {
    const result = scoreLead({
      lead: { id: 'lead-1', queuePriority: 10, attempts: 2, createdAt: '2026-09-04T10:00:00.000Z', source: 'inbound' },
      callbackDueAt: '2026-09-04T11:00:00.000Z',
      now,
      policyVersion: 1,
    });
    expect(result.score).toBeGreaterThan(500);
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'score_priority', effect: 40 }),
      expect.objectContaining({ code: 'recent_inbound', effect: 180 }),
      expect.objectContaining({ code: 'callback_due', effect: 300 }),
      expect.objectContaining({ code: 'previous_attempts', effect: -100 }),
    ]));
  });

  it('clamps unsafe policy values and score output to the contract bounds', () => {
    const policy = normalizeScorePolicy({ baseScore: 9000, priorityWeight: 9000, attemptsPenalty: 9000, ageHorizonHours: 0 });
    expect(policy.baseScore).toBe(1000);
    expect(policy.priorityWeight).toBe(50);
    expect(policy.attemptsPenalty).toBe(300);
    expect(policy.ageHorizonHours).toBe(1);
    expect(scoreLead({ lead: { queuePriority: 100, attempts: 20, createdAt: now }, now, policy }).score).toBeGreaterThanOrEqual(0);
    expect(scoreLead({ lead: { queuePriority: 100, attempts: 0, createdAt: now }, now, policy }).score).toBeLessThanOrEqual(1000);
  });

  it('orders ties with stable FIFO-compatible tie breakers', () => {
    const sorted = compareScoredLeads([
      { id: 'b', score: 700, queuePriority: 1, queueSequence: 2, nextEligibleAt: '2026-09-04T12:00:00.000Z' },
      { id: 'a', score: 700, queuePriority: 1, queueSequence: 1, nextEligibleAt: '2026-09-04T12:00:00.000Z' },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['a', 'b']);
  });
});
