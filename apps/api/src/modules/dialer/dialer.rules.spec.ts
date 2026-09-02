import {
  analyzePcm16Le,
  capacityIsAvailable,
  computeCallOutcome,
  computeRateLimitBackoffSeconds,
  computeRateLimitCooldownWindowSeconds,
  cooldownIsReady,
  isInstantFailure,
  isSelfCallNumber,
  leadIsEligible,
  normalizePhone,
  shouldQuarantineLine,
} from './dialer.rules';

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

  it('distinguishes ringing silence from actual inbound voice PCM', () => {
    const silence = new Uint8Array(640);
    expect(analyzePcm16Le(silence)).toEqual({
      sampleCount: 320,
      nonZeroSamples: 0,
      peak: 0,
      hasVoice: false,
    });

    const voice = new Int16Array(320);
    for (let index = 0; index < 20; index += 1) voice[index] = index % 2 ? 1200 : -1200;
    expect(analyzePcm16Le(new Uint8Array(voice.buffer))).toMatchObject({
      sampleCount: 320,
      nonZeroSamples: 20,
      peak: 1200,
      hasVoice: true,
    });
  });

  it('does not classify tiny comfort-noise samples as voice', () => {
    const comfortNoise = new Int16Array(320).fill(12);
    expect(analyzePcm16Le(new Uint8Array(comfortNoise.buffer)).hasVoice).toBe(false);
  });

  it('enforces global and per-number capacity', () => {
    expect(capacityIsAvailable(0, 2, 0, 1)).toBe(true);
    expect(capacityIsAvailable(2, 2, 0, 1)).toBe(false);
    expect(capacityIsAvailable(0, 2, 1, 1)).toBe(false);
  });

  it('normalizes phone numbers to digits only', () => {
    expect(normalizePhone('+55 (85) 98977-9394')).toBe('5585989779394');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });

  it('flags a lead whose phone matches the dialing line (self-call)', () => {
    expect(isSelfCallNumber('+55 85 98977-9394', '55 85 98977-9394')).toBe(true);
    expect(isSelfCallNumber('5585989779394', '5511957632036')).toBe(false);
  });

  it('floors the rate-limit backoff above the observed WhatsApp window and caps it', () => {
    expect(computeRateLimitBackoffSeconds(undefined)).toBe(180);
    expect(computeRateLimitBackoffSeconds(30)).toBe(180);
    expect(computeRateLimitBackoffSeconds(240)).toBe(240);
    expect(computeRateLimitBackoffSeconds(9999)).toBe(600);
  });

  it('bounds the rate-limit cooldown window by the line cooldown and recorded backoff', () => {
    expect(computeRateLimitCooldownWindowSeconds(60)).toBe(180);
    expect(computeRateLimitCooldownWindowSeconds(300, 120)).toBe(300);
    expect(computeRateLimitCooldownWindowSeconds(60, 9999)).toBe(600);
  });

  it('treats a call closed before the fast-fail threshold as an instant failure', () => {
    expect(isInstantFailure(2000, 5000)).toBe(true);
    expect(isInstantFailure(5000, 5000)).toBe(false);
    expect(isInstantFailure(9000, 5000)).toBe(false);
  });

  it('quarantines a line once its instant-failure streak reaches the threshold', () => {
    expect(shouldQuarantineLine(1, 2)).toBe(false);
    expect(shouldQuarantineLine(2, 2)).toBe(true);
    expect(shouldQuarantineLine(3, 2)).toBe(true);
  });

  describe('computeCallOutcome', () => {
    const base = { forceNoRetry: false, isAutomatic: true, attempts: 0, maxAttemptsPerLead: 3 };

    it('treats a Waxum rate limit as transient: cancels the call and requeues the lead immediately', () => {
      const result = computeCallOutcome({ ...base, status: 'cancelled', reason: 'waxum_rate_limited' });
      expect(result).toEqual(expect.objectContaining({ transientRateLimit: true, retryable: false, finalCallStatus: 'cancelled', leadStatus: 'queued' }));
    });

    it('retries an automatic no_answer/failed call within the attempt budget', () => {
      const result = computeCallOutcome({ ...base, status: 'no_answer', attempts: 1 });
      expect(result).toEqual(expect.objectContaining({ retryable: true, finalCallStatus: 'retry_wait', leadStatus: 'retry_wait' }));
    });

    it('does not retry once the attempt budget is exhausted', () => {
      const result = computeCallOutcome({ ...base, status: 'failed', attempts: 3 });
      expect(result).toEqual(expect.objectContaining({ retryable: false, finalCallStatus: 'failed', leadStatus: 'failed' }));
    });

    it('does not retry a manual call', () => {
      const result = computeCallOutcome({ ...base, isAutomatic: false, status: 'no_answer', attempts: 0 });
      expect(result).toEqual(expect.objectContaining({ retryable: false, finalCallStatus: 'no_answer', leadStatus: 'no_answer' }));
    });

    it('honors forceNoRetry even within the attempt budget', () => {
      const result = computeCallOutcome({ ...base, status: 'failed', attempts: 0, forceNoRetry: true });
      expect(result).toEqual(expect.objectContaining({ retryable: false, finalCallStatus: 'failed', leadStatus: 'failed' }));
    });

    it('marks a completed call completed and a cancelled call back to queued', () => {
      expect(computeCallOutcome({ ...base, status: 'completed' })).toEqual(expect.objectContaining({ finalCallStatus: 'completed', leadStatus: 'completed' }));
      expect(computeCallOutcome({ ...base, status: 'cancelled', reason: 'sdr_offer_timeout' })).toEqual(expect.objectContaining({ finalCallStatus: 'cancelled', leadStatus: 'queued' }));
    });
  });
});
