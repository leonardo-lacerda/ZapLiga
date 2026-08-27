import { capacityIsAvailable, cooldownIsReady, leadIsEligible } from './dialer.rules';

describe('dialer rules', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  it('only allows queued/retry leads before the attempt limit', () => {
    expect(leadIsEligible({ status: 'queued', attempts: 0, maxAttempts: 2, nextEligibleAt: now, now })).toBe(true);
    expect(leadIsEligible({ status: 'retry_wait', attempts: 2, maxAttempts: 2, nextEligibleAt: now, now })).toBe(false);
    expect(leadIsEligible({ status: 'retry_wait', attempts: 1, maxAttempts: 2, nextEligibleAt: new Date(now.getTime() + 1), now })).toBe(false);
  });

  it('enforces per-number cooldown', () => {
    expect(cooldownIsReady(null, 60, now)).toBe(true);
    expect(cooldownIsReady(new Date('2026-01-01T11:59:01.000Z'), 60, now)).toBe(false);
    expect(cooldownIsReady(new Date('2026-01-01T11:59:00.000Z'), 60, now)).toBe(true);
  });

  it('enforces global and per-number capacity', () => {
    expect(capacityIsAvailable(0, 2, 0, 1)).toBe(true);
    expect(capacityIsAvailable(2, 2, 0, 1)).toBe(false);
    expect(capacityIsAvailable(0, 2, 1, 1)).toBe(false);
  });
});


