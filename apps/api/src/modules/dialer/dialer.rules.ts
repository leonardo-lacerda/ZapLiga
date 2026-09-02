export function leadIsEligible(input: {
  status: string;
  attempts: number;
  maxAttempts: number;
  nextEligibleAt: Date | string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return !['completed', 'cancelled'].includes(input.status)
    && ['queued', 'retry_wait'].includes(input.status)
    && input.attempts < input.maxAttempts
    && new Date(input.nextEligibleAt).getTime() <= now.getTime();
}

export function cooldownIsReady(lastCallEndedAt: Date | string | null, cooldownSeconds: number, now = new Date()) {
  if (!lastCallEndedAt) return true;
  return new Date(lastCallEndedAt).getTime() + cooldownSeconds * 1000 <= now.getTime();
}

export function capacityIsAvailable(globalActive: number, globalMax: number, numberActive: number, numberMax: number) {
  return globalActive < globalMax && numberActive < numberMax;
}

export function normalizePhone(value: unknown) {
  return String(value ?? '').replace(/\D/g, '');
}

// WhatsApp closes the media socket immediately when a line dials its own
// number, so a lead must never be paired with the WhatsApp line that shares
// its phone number.
export function isSelfCallNumber(numberPhone: unknown, leadPhone: unknown) {
  return normalizePhone(numberPhone) === normalizePhone(leadPhone);
}

// WhatsApp/Waxum answers 429 ("wait for Ns") when it throttles outbound call
// initiation. Floor the backoff ABOVE WhatsApp's largest observed call-rate
// window (~177s) — retrying before the penalty window clears just refreshes
// it and the line never recovers.
export function computeRateLimitBackoffSeconds(waitSeconds?: number) {
  return Math.min(600, Math.max(180, Math.round(waitSeconds ?? 180)));
}

// Future-dates a line's `last_call_ended_at` so the normal cooldown gate
// (`last_call_ended_at <= now() - cooldown`) keeps the line out of rotation
// until the rate-limit backoff itself has elapsed, not just the cooldown.
export function computeRateLimitCooldownWindowSeconds(cooldownSeconds: number, backoffSeconds?: number) {
  return Math.min(600, Math.max(Number(cooldownSeconds ?? 60), Number(backoffSeconds ?? 180)));
}

// A call that opens media and closes almost instantly with no audio and no
// answer is the signature of a WhatsApp reachout timelock (463 MissingTcToken).
export function isInstantFailure(elapsedMs: number, fastFailThresholdMs: number) {
  return elapsedMs < fastFailThresholdMs;
}

export function shouldQuarantineLine(failureCount: number, threshold: number) {
  return failureCount >= threshold;
}

// A non-silent inbound PCM frame is also proof that the remote party answered:
// WhatsApp cannot capture/send their voice while the call is still ringing.
// Keep this deliberately conservative so codec comfort noise cannot reveal an
// automatic-dialer lead before an actual answer.
export function analyzePcm16Le(data: Uint8Array) {
  const sampleCount = Math.floor(data.byteLength / 2);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let peak = 0;
  let nonZeroSamples = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    if (sample !== 0) nonZeroSamples += 1;
    peak = Math.max(peak, Math.abs(sample));
  }
  const hasVoice = sampleCount >= 80
    && peak >= 256
    && nonZeroSamples / sampleCount >= 0.02;
  return { sampleCount, nonZeroSamples, peak, hasVoice };
}

// Decides how a finished call and its lead should transition, mirroring the
// three cases finishCall() must reconcile: a transient Waxum rate limit (put
// the line and lead back as if nothing happened), a retryable failure within
// the attempt budget, or a terminal outcome.
export function computeCallOutcome(input: {
  status: string;
  reason?: string;
  forceNoRetry: boolean;
  isAutomatic: boolean;
  attempts: number;
  maxAttemptsPerLead: number;
}) {
  const outcome = input.reason ?? input.status;
  const transientRateLimit = outcome === 'waxum_rate_limited';
  const retryable = input.isAutomatic && !transientRateLimit
    && ['no_answer', 'failed'].includes(input.status)
    && !input.forceNoRetry
    && input.attempts < input.maxAttemptsPerLead;
  const finalCallStatus = transientRateLimit ? 'cancelled' : retryable ? 'retry_wait' : input.status;
  const leadStatus = transientRateLimit ? 'queued'
    : retryable ? 'retry_wait'
    : input.status === 'completed' ? 'completed'
    : input.status === 'cancelled' ? 'queued'
    : input.status;
  return { outcome, transientRateLimit, retryable, finalCallStatus, leadStatus };
}
