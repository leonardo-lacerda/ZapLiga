import { calculateAnalyticsReliability } from './analytics-reliability';

describe('analytics reliability', () => {
  it('keeps an empty period explicitly insufficient', () => {
    expect(calculateAnalyticsReliability({ sourceCalls: 0, eventCalls: 0, duplicateEvents: 0, invalidEvents: 0, futureEvents: 0, outOfOrderEvents: 0, rollupDivergences: 0, pendingOutbox: 0 })).toMatchObject({ score: 0, status: 'insufficient_data' });
  });

  it('penalizes missing and invalid events without going below zero', () => {
    const result = calculateAnalyticsReliability({ sourceCalls: 10, eventCalls: 4, duplicateEvents: 2, invalidEvents: 3, futureEvents: 2, outOfOrderEvents: 1, rollupDivergences: 2, pendingOutbox: 1000 });
    expect(result.missingEvents).toBe(6);
    expect(result.status).toBe('unreliable');
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('marks complete clean coverage as reliable', () => {
    expect(calculateAnalyticsReliability({ sourceCalls: 20, eventCalls: 20, duplicateEvents: 0, invalidEvents: 0, futureEvents: 0, outOfOrderEvents: 0, rollupDivergences: 0, pendingOutbox: 0 })).toMatchObject({ score: 100, status: 'reliable' });
  });
});
