import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DecisionRepository } from './decision.repository';
import { DecisionPolicyService } from './decision-policy.service';
import { EligibilityResult } from './eligibility.service';
import { compareScoredLeads, scoreLead } from './scoring.service';

@Injectable()
export class DecisionShadowService {
  constructor(private readonly decisions: DecisionRepository, private readonly policies: DecisionPolicyService) {}

  async recordBatch(tenantId: string, campaignId: string, candidates: Array<{ lead: any; fifoPosition: number; eligibility?: EligibilityResult }>) {
    const mode = await this.decisions.mode(tenantId, campaignId);
    if (mode !== 'shadow') return { recorded: false, mode };
    const started = Date.now();
    const policy = await this.policies.getPolicy(tenantId, campaignId);
    const dedupeWindow = Math.floor(Date.now() / 60_000);
    const scored = candidates.map((candidate) => ({ ...candidate, score: scoreLead({
      lead: { id: candidate.lead.id, queuePriority: candidate.lead.queue_priority, attempts: candidate.lead.attempts, createdAt: candidate.lead.created_at, queuedAt: candidate.lead.queued_at, sourceIntegrationId: candidate.lead.source_integration_id, source: candidate.lead.source },
      now: new Date(), policy: policy.weights, policyVersion: policy.version,
    }) }));
    const sorted = compareScoredLeads(scored.map((item) => ({ id: item.lead.id, score: item.score.score, queuePriority: item.lead.queue_priority, queueSequence: item.lead.queue_sequence, nextEligibleAt: item.lead.next_eligible_at })));
    const suggested = new Map(sorted.filter((item) => candidates.find((candidate) => candidate.lead.id === item.id)?.eligibility?.eligible !== false).map((item, index) => [item.id, index + 1]));
    for (const candidate of scored) {
      const elapsed = Math.max(0, Date.now() - started);
      await this.decisions.recordDecision({
        id: randomUUID(), tenantId, campaignId, leadId: candidate.lead.id, policyId: policy.id, policyVersion: policy.version, mode: 'shadow', score: candidate.score.score,
        reasonCodes: [...(candidate.eligibility?.reasonCodes ?? []), ...candidate.score.reasons.map((reason) => reason.code)], featureSnapshot: { ...candidate.score.featureSnapshot, eligibility: candidate.eligibility?.blockedBy ?? [] },
        fifoPosition: candidate.fifoPosition, suggestedPosition: suggested.get(candidate.lead.id) ?? null, finalDecision: candidate.eligibility && !candidate.eligibility.eligible ? 'blocked' : 'fifo', latencyMs: elapsed,
        dedupeKey: `shadow:${campaignId}:${policy.id}:${candidate.lead.id}:${dedupeWindow}`,
      });
    }
    return { recorded: true, mode, count: scored.length };
  }
}
