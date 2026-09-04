import { RoadmapReasonCode } from '../roadmap-contracts/roadmap-contracts';

export const SCORE_POLICY_VERSION = 1 as const;

export type ScorePolicyWeights = {
  baseScore: number;
  priorityWeight: number;
  recentInboundWeight: number;
  ageWeight: number;
  callbackDueWeight: number;
  attemptsPenalty: number;
  fairnessWeight: number;
  recentInboundHours: number;
  ageHorizonHours: number;
};

export const DEFAULT_SCORE_POLICY: ScorePolicyWeights = {
  baseScore: 500,
  priorityWeight: 4,
  recentInboundWeight: 180,
  ageWeight: 120,
  callbackDueWeight: 300,
  attemptsPenalty: 50,
  fairnessWeight: 100,
  recentInboundHours: 24,
  ageHorizonHours: 72,
};

export type ScoreLeadInput = {
  lead: {
    id?: string;
    queuePriority?: number | string | null;
    attempts?: number | string | null;
    createdAt?: Date | string | null;
    queuedAt?: Date | string | null;
    sourceIntegrationId?: string | null;
    source?: string | null;
  };
  callbackDueAt?: Date | string | null;
  fairnessBoost?: number;
  now?: Date;
  policy?: Partial<ScorePolicyWeights>;
  policyVersion?: number;
};

export type ScoreReason = { code: RoadmapReasonCode; effect: number; metadata?: Record<string, unknown> };

export type ScoreResult = {
  score: number;
  policyVersion: number;
  reasons: ScoreReason[];
  featureSnapshot: Record<string, unknown>;
};

const finite = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function normalizeScorePolicy(policy?: Partial<ScorePolicyWeights> | null): ScorePolicyWeights {
  const source = { ...DEFAULT_SCORE_POLICY, ...(policy ?? {}) };
  return {
    baseScore: Math.round(Math.min(1000, Math.max(0, finite(source.baseScore, DEFAULT_SCORE_POLICY.baseScore)))),
    priorityWeight: Math.round(Math.min(50, Math.max(-50, finite(source.priorityWeight, DEFAULT_SCORE_POLICY.priorityWeight)))),
    recentInboundWeight: Math.round(Math.min(400, Math.max(0, finite(source.recentInboundWeight, DEFAULT_SCORE_POLICY.recentInboundWeight)))),
    ageWeight: Math.round(Math.min(400, Math.max(0, finite(source.ageWeight, DEFAULT_SCORE_POLICY.ageWeight)))),
    callbackDueWeight: Math.round(Math.min(500, Math.max(0, finite(source.callbackDueWeight, DEFAULT_SCORE_POLICY.callbackDueWeight)))),
    attemptsPenalty: Math.round(Math.min(300, Math.max(0, finite(source.attemptsPenalty, DEFAULT_SCORE_POLICY.attemptsPenalty)))),
    fairnessWeight: Math.round(Math.min(300, Math.max(0, finite(source.fairnessWeight, DEFAULT_SCORE_POLICY.fairnessWeight)))),
    recentInboundHours: Math.min(168, Math.max(1, finite(source.recentInboundHours, DEFAULT_SCORE_POLICY.recentInboundHours))),
    ageHorizonHours: Math.min(720, Math.max(1, finite(source.ageHorizonHours, DEFAULT_SCORE_POLICY.ageHorizonHours))),
  };
}

const validDate = (value: unknown) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value == null) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
};

export function scoreLead(input: ScoreLeadInput): ScoreResult {
  const now = input.now ?? new Date();
  const policy = normalizeScorePolicy(input.policy);
  const createdAt = validDate(input.lead.queuedAt) ?? validDate(input.lead.createdAt) ?? now;
  const ageHours = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
  const priority = Math.max(-100, Math.min(100, Math.round(finite(input.lead.queuePriority, 0))));
  const attempts = Math.max(0, Math.round(finite(input.lead.attempts, 0)));
  const callbackDueAt = validDate(input.callbackDueAt);
  const callbackDue = Boolean(callbackDueAt && callbackDueAt.getTime() <= now.getTime());
  const recentInbound = Boolean(input.lead.sourceIntegrationId || String(input.lead.source ?? '').toLowerCase() === 'inbound') && ageHours <= policy.recentInboundHours;
  const ageRatio = Math.max(0, Math.min(1, 1 - ageHours / policy.ageHorizonHours));
  const ageEffect = Math.round(policy.ageWeight * ageRatio);
  const priorityEffect = Math.round(priority * policy.priorityWeight);
  const callbackEffect = callbackDue ? policy.callbackDueWeight : 0;
  const inboundEffect = recentInbound ? policy.recentInboundWeight : 0;
  const attemptsEffect = -Math.min(500, attempts * policy.attemptsPenalty);
  const fairnessEffect = Math.round(Math.max(-1, Math.min(1, finite(input.fairnessBoost, 0))) * policy.fairnessWeight);
  const reasons = ([
    { code: 'score_priority', effect: priorityEffect, metadata: { queuePriority: priority } },
    { code: 'lead_age', effect: ageEffect, metadata: { ageHours: Math.round(ageHours * 10) / 10 } },
    { code: 'recent_inbound', effect: inboundEffect, metadata: { recentInbound } },
    { code: 'callback_due', effect: callbackEffect, metadata: { callbackDue } },
    { code: 'previous_attempts', effect: attemptsEffect, metadata: { attempts } },
    { code: 'queue_fairness', effect: fairnessEffect, metadata: { fairnessBoost: Math.round(finite(input.fairnessBoost, 0) * 100) / 100 } },
  ] as ScoreReason[]).filter((reason) => reason.effect !== 0 || ['score_priority', 'lead_age', 'previous_attempts'].includes(reason.code));
  const score = Math.min(1000, Math.max(0, Math.round(policy.baseScore + reasons.reduce((total, reason) => total + reason.effect, 0))));
  return {
    score,
    policyVersion: input.policyVersion ?? SCORE_POLICY_VERSION,
    reasons,
    featureSnapshot: {
      ageHours: Math.round(ageHours * 10) / 10,
      queuePriority: priority,
      attempts,
      recentInbound,
      callbackDue,
      sourceType: input.lead.sourceIntegrationId || String(input.lead.source ?? '').toLowerCase() === 'inbound' ? 'inbound' : 'other',
    },
  };
}

export function compareScoredLeads<T extends { id?: string; queueSequence?: number | string | null; queuePriority?: number | string | null; nextEligibleAt?: Date | string | null }>(items: Array<T & { score: number }>) {
  return [...items].sort((left, right) => right.score - left.score
    || Number(right.queuePriority ?? 0) - Number(left.queuePriority ?? 0)
    || new Date(String(left.nextEligibleAt ?? 0)).getTime() - new Date(String(right.nextEligibleAt ?? 0)).getTime()
    || Number(left.queueSequence ?? 0) - Number(right.queueSequence ?? 0)
    || String(left.id ?? '').localeCompare(String(right.id ?? '')));
}
