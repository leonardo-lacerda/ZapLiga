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


