export const HEALTH_FORMULA_VERSION = 'v1';

export type HealthState = 'healthy' | 'attention' | 'degraded' | 'blocked' | 'insufficient_data';

export type OperationHealthSignals = {
  numbers: {
    total: number;
    connected: number;
    cooldown: number;
    quarantined: number;
    rateLimited: number;
    rapidFailures: number;
  };
  calls: { attempts: number; failures: number };
  capacity: { total: number; active: number };
  team: { total: number; available: number };
  queue: { ready: number; waiting: number; dueCallbacks: number; exhausted: number };
  compliance: { scheduleAllowed: boolean; suppressionBlocks: number; policyBlocks: number };
};

export type HealthComponent = {
  code: string;
  score: number;
  weight: number;
  numerator: number;
  denominator: number;
};

export type HealthResult = {
  state: HealthState;
  score: number;
  components: HealthComponent[];
  reasonCodes: string[];
  hardBlocks: string[];
  sampleSize: { attempts: number; numbers: number; leads: number };
  formulaVersion: string;
};

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const integer = (value: unknown) => Math.max(0, Number(value) || 0);

function component(code: string, score: number, weight: number, numerator: number, denominator: number): HealthComponent {
  return { code, score: Math.round(clamp(score)), weight, numerator: Math.round(integer(numerator)), denominator: Math.round(integer(denominator)) };
}

export function calculateOperationHealth(input: OperationHealthSignals): HealthResult {
  const numbers = input.numbers;
  const calls = input.calls;
  const capacity = input.capacity;
  const team = input.team;
  const queue = input.queue;
  const compliance = input.compliance;

  const connectivityScore = numbers.total > 0 ? (numbers.connected / numbers.total) * 100 : 0;
  const failureRate = calls.attempts > 0 ? calls.failures / calls.attempts : 0;
  const protectionRatio = numbers.total > 0 ? (numbers.cooldown + numbers.quarantined) / numbers.total : 0;
  const stabilityScore = calls.attempts > 0
    ? clamp(100 - failureRate * 180 - (numbers.rateLimited + numbers.rapidFailures) * 8)
    : (numbers.total > 0 ? clamp(85 - protectionRatio * 80) : 0);
  const capacityScore = capacity.total > 0
    ? clamp(100 - protectionRatio * 70 - Math.max(0, capacity.active / capacity.total - 0.9) * 100)
    : 0;
  const teamScore = team.total > 0 ? (team.available / team.total) * 100 : 0;
  const queueScore = queue.ready > 0
    ? (team.available > 0 && capacity.total > capacity.active ? 100 : 25)
    : (queue.waiting > 0 ? 65 : 80);
  const complianceScore = compliance.scheduleAllowed && compliance.policyBlocks === 0 ? 100 : 0;

  const hardBlocks: string[] = [];
  if (!compliance.scheduleAllowed) hardBlocks.push('outside_schedule');
  if (compliance.policyBlocks > 0) hardBlocks.push('policy_block');

  const reasonCodes: string[] = [];
  if (numbers.total > 0 && numbers.connected === 0) reasonCodes.push('no_connected_number');
  if (calls.attempts >= 10 && failureRate >= 0.35) reasonCodes.push('high_failure_rate');
  if (numbers.rateLimited > 0) reasonCodes.push('rate_limited_numbers');
  if (numbers.rapidFailures > 0) reasonCodes.push('rapid_failure_streak');
  if (numbers.quarantined > 0) reasonCodes.push('numbers_quarantined');
  if (numbers.cooldown > 0) reasonCodes.push('numbers_in_cooldown');
  if (queue.ready > 0 && team.available === 0) reasonCodes.push('no_available_sdr');
  if (queue.ready > 0 && capacity.total <= capacity.active) reasonCodes.push('capacity_exhausted');
  if (queue.exhausted > 0) reasonCodes.push('leads_attempt_limit');
  if (queue.dueCallbacks > 0) reasonCodes.push('callbacks_due');
  if (compliance.suppressionBlocks > 0) reasonCodes.push('suppressed_contacts');
  reasonCodes.push(...hardBlocks);

  const components = [
    component('connectivity', connectivityScore, 0.25, numbers.connected, numbers.total),
    component('stability', stabilityScore, 0.25, Math.max(0, calls.attempts - calls.failures), calls.attempts),
    component('capacity', capacityScore, 0.2, Math.max(0, capacity.total - capacity.active), capacity.total),
    component('team', teamScore, 0.15, team.available, team.total),
    component('queue', queueScore, 0.1, queue.ready, queue.ready + queue.waiting),
    component('compliance', complianceScore, 0.05, compliance.scheduleAllowed && compliance.policyBlocks === 0 ? 1 : 0, 1),
  ];
  const weightedScore = Math.round(components.reduce((sum, item) => sum + item.score * item.weight, 0));
  const sampleSize = { attempts: integer(calls.attempts), numbers: integer(numbers.total), leads: integer(queue.ready + queue.waiting + queue.exhausted) };
  const insufficient = !hardBlocks.length && sampleSize.attempts < 10 && sampleSize.numbers === 0;
  const state: HealthState = hardBlocks.length
    ? 'blocked'
    : insufficient
      ? 'insufficient_data'
      : weightedScore >= 80
        ? 'healthy'
        : weightedScore >= 60
          ? 'attention'
          : 'degraded';

  if (insufficient) reasonCodes.push('insufficient_sample');
  return { state, score: hardBlocks.length ? 0 : weightedScore, components, reasonCodes: [...new Set(reasonCodes)], hardBlocks, sampleSize, formulaVersion: HEALTH_FORMULA_VERSION };
}

export type NumberHealthSignals = {
  status: string;
  calls: { attempts: number; failures: number; rateLimited: number; rapidFailures: number };
  protections: { cooldown: boolean; quarantine: boolean };
};

export function calculateNumberHealth(input: NumberHealthSignals): HealthResult {
  const status = String(input.status).toLowerCase();
  const connected = ['connected', 'online', 'ready', 'authenticated'].includes(status);
  const protectionCount = Number(input.protections.cooldown) + Number(input.protections.quarantine);
  const result = calculateOperationHealth({
    numbers: { total: 1, connected: connected ? 1 : 0, cooldown: input.protections.cooldown ? 1 : 0, quarantined: input.protections.quarantine ? 1 : 0, rateLimited: input.calls.rateLimited, rapidFailures: input.calls.rapidFailures },
    calls: input.calls,
    capacity: { total: 1, active: 0 },
    team: { total: 1, available: 1 },
    queue: { ready: 0, waiting: 0, dueCallbacks: 0, exhausted: 0 },
    compliance: { scheduleAllowed: true, suppressionBlocks: 0, policyBlocks: 0 },
  });
  const reasonCodes = [...result.reasonCodes];
  if (protectionCount > 0 && !reasonCodes.includes('line_protected')) reasonCodes.push('line_protected');
  return { ...result, reasonCodes };
}
