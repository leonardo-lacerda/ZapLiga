export const ANALYTICS_RELIABILITY_FORMULA_VERSION = 1 as const;

export type ReliabilityStatus = 'reliable' | 'attention' | 'unreliable' | 'insufficient_data';

export type ReliabilityInput = {
  sourceCalls: number;
  eventCalls: number;
  duplicateEvents: number;
  invalidEvents: number;
  futureEvents: number;
  outOfOrderEvents: number;
  rollupDivergences: number;
  pendingOutbox: number;
};

export function calculateAnalyticsReliability(input: ReliabilityInput) {
  const sourceCalls = Math.max(0, Number(input.sourceCalls) || 0);
  const eventCalls = Math.max(0, Number(input.eventCalls) || 0);
  const missingEvents = Math.max(0, sourceCalls - eventCalls);
  const coveragePenalty = sourceCalls ? (missingEvents / sourceCalls) * 45 : 0;
  const duplicatePenalty = Math.min(20, Math.max(0, Number(input.duplicateEvents) || 0) * 2);
  const invalidPenalty = Math.min(25, Math.max(0, Number(input.invalidEvents) || 0) * 3);
  const futurePenalty = Math.min(15, Math.max(0, Number(input.futureEvents) || 0) * 2);
  const orderPenalty = Math.min(15, Math.max(0, Number(input.outOfOrderEvents) || 0) * 2);
  const rollupPenalty = Math.min(20, Math.max(0, Number(input.rollupDivergences) || 0) * 2);
  const outboxPenalty = Math.min(10, Math.max(0, Number(input.pendingOutbox) || 0) / 10);
  const score = sourceCalls === 0 && eventCalls === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round(100 - coveragePenalty - duplicatePenalty - invalidPenalty - futurePenalty - orderPenalty - rollupPenalty - outboxPenalty)));
  const status: ReliabilityStatus = sourceCalls + eventCalls === 0
    ? 'insufficient_data'
    : score >= 95 ? 'reliable' : score >= 80 ? 'attention' : 'unreliable';
  return { score, status, missingEvents, formulaVersion: ANALYTICS_RELIABILITY_FORMULA_VERSION };
}
