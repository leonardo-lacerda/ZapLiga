import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { EligibilityService } from './eligibility.service';
import { DecisionRepository } from './decision.repository';
import { compareScoredLeads, DEFAULT_SCORE_POLICY, normalizeScorePolicy, scoreLead, ScorePolicyWeights } from './scoring.service';
import { AnalyticsEventsService } from '../analytics-events/analytics-events.service';

const publicPolicy = (row: any) => ({
  id: row.id,
  tenant_id: row.tenant_id,
  campaign_id: row.campaign_id,
  version: Number(row.version),
  status: row.status,
  weights: normalizeScorePolicy(row.weights),
  rationale: row.rationale,
  config_hash: row.config_hash,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

@Injectable()
export class DecisionPolicyService {
  constructor(private readonly db: DatabaseService, private readonly decisions: DecisionRepository, private readonly eligibility: EligibilityService, @Optional() private readonly redis?: RedisService, @Optional() private readonly analytics?: AnalyticsEventsService) {}

  private incrementMetric(name: string, amount = 1) { void this.redis?.incrementMetric(`decision_${name}`, amount); }
  private observeMetric(name: string, durationMs: number) { void this.redis?.observeMetric(`decision_${name}`, durationMs); }

  private async assertCampaign(tenantId: string, campaignId: string, executor = this.db) {
    const row = (await executor.query(`SELECT c.id, c.status, c.current_version, c.folder_id, cv.config_snapshot AS config_snapshot
      FROM campaigns c LEFT JOIN campaign_versions cv ON cv.tenant_id=c.tenant_id AND cv.campaign_id=c.id AND cv.version=c.current_version
      WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, campaignId])).rows[0];
    if (!row) throw new NotFoundException('Campanha nao encontrada');
    return row;
  }

  private policyHash(weights: ScorePolicyWeights) {
    return createHash('sha256').update(JSON.stringify(weights)).digest('hex');
  }

  async getPolicy(tenantId: string, campaignId: string) {
    await this.assertCampaign(tenantId, campaignId);
    let row = await this.decisions.currentPolicy(tenantId, campaignId);
    if (!row) {
      const weights = normalizeScorePolicy(DEFAULT_SCORE_POLICY);
      try {
        await this.db.query(`INSERT INTO decision_policies (id,tenant_id,campaign_id,version,status,weights,rationale,config_hash)
          VALUES ($1,$2,$3,1,'published',$4::jsonb,$5,$6) ON CONFLICT DO NOTHING`, [randomUUID(), tenantId, campaignId, JSON.stringify(weights), 'Politica conservadora inicial', this.policyHash(weights)]);
      } catch { /* another request may have initialized the same campaign */ }
      row = await this.decisions.currentPolicy(tenantId, campaignId);
    }
    if (!row) throw new Error('Politica de decisao indisponivel');
    return { ...publicPolicy(row), mode: await this.decisions.mode(tenantId, campaignId) };
  }

  async updatePolicy(tenantId: string, campaignId: string, userId: string, input: { weights: Partial<ScorePolicyWeights>; rationale?: string }) {
    await this.assertCampaign(tenantId, campaignId);
    const weights = normalizeScorePolicy(input.weights);
    const hash = this.policyHash(weights);
    const row = await this.db.transaction(async (client) => {
      const current = await this.decisions.latestPolicy(tenantId, campaignId, client);
      const version = Number(current?.version ?? 0) + 1;
      await client.query(`UPDATE decision_policies SET status='archived', updated_at=now() WHERE tenant_id=$1 AND campaign_id=$2 AND status='published'`, [tenantId, campaignId]);
      return this.decisions.insertPolicy(client, { id: randomUUID(), tenantId, campaignId, version, weights, rationale: input.rationale?.trim() || null, hash, userId });
    });
    return { ...publicPolicy(row), mode: await this.decisions.mode(tenantId, campaignId) };
  }

  async setMode(tenantId: string, campaignId: string, userId: string, mode: 'disabled' | 'shadow' | 'active') {
    await this.assertCampaign(tenantId, campaignId);
    return this.decisions.saveMode(tenantId, campaignId, mode, userId);
  }

  async prioritizeCandidates(tenantId: string, candidates: any[]) {
    const started = Date.now();
    const now = new Date();
    const ranked = [...candidates];
    const contexts = new Map<string, { campaignId: string; policyId: string; policyVersion: number; score: number; reasons: any[]; featureSnapshot: Record<string, unknown>; fifoPosition: number; suggestedPosition: number; starvationProtected: boolean; latencyMs: number }>();
    const groups = new Map<string, Array<{ row: any; sourceIndex: number }>>();
    for (const [sourceIndex, row] of candidates.entries()) {
      if (!row.campaign_id) continue;
      const group = groups.get(String(row.campaign_id)) ?? [];
      group.push({ row, sourceIndex });
      groups.set(String(row.campaign_id), group);
    }
    for (const [campaignId, group] of groups) {
      const campaignStarted = Date.now();
      try {
        const policy = await this.getPolicy(tenantId, campaignId);
        if (policy.mode !== 'active') continue;
        const scored = group.map((item, fifoIndex) => {
          const queuedAt = new Date(String(item.row.queued_at ?? item.row.created_at ?? now.toISOString()));
          const ageHours = Number.isFinite(queuedAt.getTime()) ? Math.max(0, (now.getTime() - queuedAt.getTime()) / 3_600_000) : 0;
          const provisional = scoreLead({
            lead: { id: item.row.id, queuePriority: item.row.queue_priority, attempts: item.row.attempts, createdAt: item.row.created_at, queuedAt: item.row.queued_at, sourceIntegrationId: item.row.source_integration_id },
            now, policy: policy.weights, policyVersion: policy.version,
            fairnessBoost: Math.min(1, Math.max(0, ageHours / 12)),
          });
          return { ...item, score: provisional, fifoIndex, starvationProtected: ageHours >= 24 };
        });
        const sorted = compareScoredLeads(scored.map((item) => ({ ...item, id: item.row.id, score: item.score.score, queuePriority: item.row.queue_priority, queueSequence: item.row.queue_sequence, nextEligibleAt: item.row.next_eligible_at, starvationProtected: item.starvationProtected })));
        const sortedById = new Map(sorted.map((item, suggestedIndex) => [item.id, { ...item, suggestedIndex }]));
        for (const [destinationIndex, item] of sorted.entries()) ranked[group[destinationIndex].sourceIndex] = item.row;
        for (const item of scored) {
          const selected = sortedById.get(item.row.id);
          if (!selected) continue;
          contexts.set(String(item.row.id), { campaignId, policyId: policy.id, policyVersion: policy.version, score: item.score.score, reasons: item.score.reasons, featureSnapshot: item.score.featureSnapshot, fifoPosition: item.fifoIndex + 1, suggestedPosition: selected.suggestedIndex + 1, starvationProtected: item.starvationProtected, latencyMs: Math.max(0, Date.now() - campaignStarted) });
          if (item.starvationProtected) this.incrementMetric('active_starvation_guard_total');
        }
        this.incrementMetric('active_evaluations_total', scored.length);
      } catch {
        this.incrementMetric('active_fallback_total');
      }
    }
    const elapsed = Math.max(0, Date.now() - started);
    this.incrementMetric('active_ranked_total', contexts.size);
    this.observeMetric('evaluation_latency', elapsed);
    return { rows: ranked, contexts, latencyMs: elapsed };
  }

  async recordActiveDecision(context: { tenantId: string; campaignId: string; leadId: string; callId: string; policyId: string; policyVersion: number; score: number; reasons: any[]; featureSnapshot: Record<string, unknown>; fifoPosition: number; suggestedPosition: number; starvationProtected: boolean; latencyMs: number; eligibility?: { reasonCodes?: string[]; blockedBy?: string[] } }) {
    const decision = await this.decisions.recordDecision({
      id: randomUUID(), tenantId: context.tenantId, campaignId: context.campaignId, leadId: context.leadId, callId: context.callId,
      policyId: context.policyId, policyVersion: context.policyVersion, mode: 'active', score: context.score,
      reasonCodes: [...(context.eligibility?.reasonCodes ?? []), ...context.reasons.map((reason) => reason.code)], featureSnapshot: { ...context.featureSnapshot, starvationProtected: context.starvationProtected, eligibility: context.eligibility?.blockedBy ?? [] },
      fifoPosition: context.fifoPosition, suggestedPosition: context.suggestedPosition, finalDecision: 'score', latencyMs: context.latencyMs, dedupeKey: `active:${context.callId}`,
    });
    const reasonCodes = [...(context.eligibility?.reasonCodes ?? []), ...context.reasons.map((reason) => reason.code)];
    void this.analytics?.record({
      tenantId: context.tenantId,
      eventType: 'decision.scored',
      aggregateType: 'lead',
      aggregateId: context.leadId,
      campaignId: context.campaignId,
      idempotencyKey: `decision.scored:active:${context.callId}`,
      payload: { leadId: context.leadId, score: context.score, policyVersion: context.policyVersion, reasonCodes },
    }).catch(() => undefined);
    void this.analytics?.record({
      tenantId: context.tenantId,
      eventType: 'decision.selected',
      aggregateType: 'lead',
      aggregateId: context.leadId,
      campaignId: context.campaignId,
      idempotencyKey: `decision.selected:${context.callId}`,
      payload: { leadId: context.leadId, score: context.score, policyVersion: context.policyVersion },
    }).catch(() => undefined);
    this.incrementMetric('active_decisions_recorded_total');
    return decision;
  }

  async simulate(tenantId: string, campaignId: string, input: { leadId?: string; limit?: number }) {
    const campaign = await this.assertCampaign(tenantId, campaignId);
    const policy = await this.getPolicy(tenantId, campaignId);
    const rules = campaign.config_snapshot?.rules ?? {};
    const globalSettings = (await this.db.query(`SELECT max_attempts_per_lead FROM dialer_settings WHERE tenant_id=$1`, [tenantId])).rows[0] ?? {};
    const maxAttempts = Math.min(Number(globalSettings.max_attempts_per_lead ?? 2), Number(rules.maxAttemptsPerLead ?? globalSettings.max_attempts_per_lead ?? 2));
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 12) || 12));
    const candidates = (await this.db.query(`
      SELECT l.id, l.phone, l.status, l.attempts, l.next_eligible_at, l.do_not_call, l.queue_priority, l.queue_sequence, l.created_at, l.queued_at, l.source_integration_id,
        f.is_active AS folder_active,
        EXISTS (SELECT 1 FROM contact_suppressions cs WHERE cs.tenant_id=l.tenant_id AND cs.phone=l.phone AND cs.lifted_at IS NULL) AS contact_suppressed,
        EXISTS (SELECT 1 FROM calls active_call WHERE active_call.tenant_id=l.tenant_id AND active_call.lead_id=l.id AND active_call.status IN ('reserved','dialing','media_active')) AS active_call,
        callback.status AS callback_status, callback.assigned_sdr_id AS callback_assigned_sdr_id, callback.due_at AS callback_due_at
      FROM leads l JOIN campaigns c ON c.tenant_id=l.tenant_id AND c.id=l.campaign_id
      JOIN lead_folders f ON f.tenant_id=l.tenant_id AND f.id=l.folder_id
      LEFT JOIN LATERAL (SELECT cb.status, cb.assigned_sdr_id, cb.due_at FROM lead_callbacks cb WHERE cb.tenant_id=l.tenant_id AND cb.lead_id=l.id AND cb.status IN ('pending','due','reassigned') ORDER BY cb.due_at ASC LIMIT 1) callback ON true
      WHERE l.tenant_id=$1 AND l.campaign_id=$2 AND ($3::text IS NULL OR l.id=$3)
      ORDER BY CASE WHEN $4 = 'priority_fifo' THEN l.queue_priority ELSE 0 END DESC,
        CASE WHEN $4 = 'lifo' THEN -l.queue_sequence ELSE l.queue_sequence END ASC,
        l.next_eligible_at ASC, l.created_at ASC
      LIMIT $5`, [tenantId, campaignId, input.leadId ?? null, rules.queueStrategy ?? 'fifo', limit])).rows;
    const now = new Date();
    const scored = candidates.map((row: any, index: number) => {
      const eligibility = this.eligibility.evaluate({
        mode: 'simulation',
        lead: { id: row.id, phone: row.phone, status: row.status, attempts: row.attempts, nextEligibleAt: row.next_eligible_at, doNotCall: row.do_not_call },
        maxAttempts,
        folderActive: row.folder_active,
        contactSuppressed: row.contact_suppressed,
        activeCall: row.active_call,
        callback: row.callback_status ? { status: row.callback_status, assignedSdrId: row.callback_assigned_sdr_id, dueAt: row.callback_due_at } : null,
        campaignAllowed: campaign.status === 'running',
        scheduleAllowed: true,
        now,
      });
      const score = scoreLead({
        lead: { id: row.id, queuePriority: row.queue_priority, attempts: row.attempts, createdAt: row.created_at, queuedAt: row.queued_at, sourceIntegrationId: row.source_integration_id, source: row.source },
        callbackDueAt: row.callback_due_at,
        now,
        policy: policy.weights,
        policyVersion: policy.version,
      });
      return { id: row.id, status: row.status, attempts: Number(row.attempts), next_eligible_at: row.next_eligible_at, queue_priority: Number(row.queue_priority ?? 0), queue_sequence: Number(row.queue_sequence ?? 0), fifo_position: index + 1, constraints: eligibility.reasons.filter((reason) => reason.allowed).map((reason) => reason.code), eligibility, ...score };
    });
    const sorted = compareScoredLeads(scored.map((row) => ({ ...row, nextEligibleAt: row.next_eligible_at, queuePriority: row.queue_priority, queueSequence: row.queue_sequence })));
    const suggested = new Map(sorted.filter((row) => row.eligibility.eligible).map((row, index) => [row.id, index + 1]));
    return {
      campaign: { id: campaign.id, status: campaign.status, current_version: campaign.current_version },
      policy,
      mode: await this.decisions.mode(tenantId, campaignId),
      candidates: scored.map((row) => ({ ...row, suggested_position: suggested.get(row.id) ?? null })),
    };
  }

  async comparison(tenantId: string, campaignId: string, limit?: number) {
    await this.assertCampaign(tenantId, campaignId);
    const decisions = await this.decisions.listDecisions(tenantId, campaignId, limit);
    const deltas = decisions.filter((row) => row.fifo_position != null && row.suggested_position != null).map((row) => Number(row.fifo_position) - Number(row.suggested_position));
    const latencies = decisions.map((row) => Number(row.evaluation_latency_ms ?? 0)).sort((left, right) => left - right);
    const percentile = (ratio: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * ratio) - 1)] : 0;
    const byDecision = decisions.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.final_decision]: (counts[row.final_decision] ?? 0) + 1 }), {});
    const byLead = decisions.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.lead_id]: (counts[row.lead_id] ?? 0) + 1 }), {});
    return { campaign_id: campaignId, mode: await this.decisions.mode(tenantId, campaignId), decisions, summary: { count: decisions.length, average_position_delta: deltas.length ? Math.round((deltas.reduce((sum, value) => sum + value, 0) / deltas.length) * 100) / 100 : 0, fallback_count: decisions.filter((row) => row.final_decision === 'fallback').length, distribution: { by_decision: byDecision, distinct_leads: Object.keys(byLead).length }, latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) } } };
  }

  async leadDecision(tenantId: string, leadId: string) {
    const existing = await this.decisions.latestDecisionForLead(tenantId, leadId);
    if (existing) return existing;
    const lead = (await this.db.query('SELECT campaign_id FROM leads WHERE tenant_id=$1 AND id=$2', [tenantId, leadId])).rows[0];
    if (!lead?.campaign_id) throw new NotFoundException('Decisao ainda nao registrada para este lead');
    const simulated = await this.simulate(tenantId, lead.campaign_id, { leadId, limit: 1 });
    return simulated.candidates[0] ?? { eligible: false, blockedBy: ['lead_status_ineligible'] };
  }
}
