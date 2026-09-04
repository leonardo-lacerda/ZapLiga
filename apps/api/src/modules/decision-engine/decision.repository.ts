import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

type QueryExecutor = { query: (text: string, params?: any[]) => Promise<any> };

@Injectable()
export class DecisionRepository {
  constructor(private readonly db: DatabaseService) {}

  async currentPolicy(tenantId: string, campaignId: string, executor: QueryExecutor = this.db) {
    return (await executor.query(`SELECT * FROM decision_policies WHERE tenant_id=$1 AND campaign_id=$2 AND status='published' ORDER BY version DESC LIMIT 1`, [tenantId, campaignId])).rows[0] ?? null;
  }

  async latestPolicy(tenantId: string, campaignId: string, executor: QueryExecutor = this.db) {
    return (await executor.query(`SELECT * FROM decision_policies WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY version DESC LIMIT 1`, [tenantId, campaignId])).rows[0] ?? null;
  }

  async insertPolicy(executor: QueryExecutor, input: { id: string; tenantId: string; campaignId: string; version: number; weights: Record<string, unknown>; rationale?: string | null; hash: string; userId?: string | null }) {
    return (await executor.query(`INSERT INTO decision_policies (id,tenant_id,campaign_id,version,status,weights,rationale,config_hash,created_by_user_id)
      VALUES ($1,$2,$3,$4,'published',$5::jsonb,$6,$7,$8) RETURNING *`, [input.id, input.tenantId, input.campaignId, input.version, JSON.stringify(input.weights), input.rationale ?? null, input.hash, input.userId ?? null])).rows[0];
  }

  async mode(tenantId: string, campaignId: string, executor: QueryExecutor = this.db) {
    return (await executor.query(`SELECT mode FROM decision_campaign_modes WHERE tenant_id=$1 AND campaign_id=$2`, [tenantId, campaignId])).rows[0]?.mode ?? 'shadow';
  }

  async saveMode(tenantId: string, campaignId: string, mode: string, userId: string, executor: QueryExecutor = this.db) {
    return (await executor.query(`INSERT INTO decision_campaign_modes (tenant_id,campaign_id,mode,updated_by_user_id,updated_at)
      VALUES ($1,$2,$3,$4,now()) ON CONFLICT (tenant_id,campaign_id) DO UPDATE SET mode=EXCLUDED.mode, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()
      RETURNING tenant_id,campaign_id,mode,updated_at`, [tenantId, campaignId, mode, userId])).rows[0];
  }

  async insertDecision(executor: QueryExecutor, input: { id: string; tenantId: string; campaignId: string; leadId: string; callId?: string | null; policyId: string; policyVersion: number; mode: 'shadow' | 'active'; score: number; reasonCodes: unknown[]; featureSnapshot: Record<string, unknown>; fifoPosition?: number | null; suggestedPosition?: number | null; finalDecision: 'fifo' | 'score' | 'fallback' | 'blocked'; latencyMs: number; dedupeKey?: string | null }) {
    return (await executor.query(`INSERT INTO call_decisions (id,tenant_id,campaign_id,lead_id,call_id,policy_id,policy_version,mode,score,reason_codes,feature_snapshot,fifo_position,suggested_position,final_decision,evaluation_latency_ms,dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING *`, [input.id, input.tenantId, input.campaignId, input.leadId, input.callId ?? null, input.policyId, input.policyVersion, input.mode, input.score, JSON.stringify(input.reasonCodes), JSON.stringify(input.featureSnapshot), input.fifoPosition ?? null, input.suggestedPosition ?? null, input.finalDecision, input.latencyMs, input.dedupeKey ?? null])).rows[0];
  }

  async recordDecision(input: Parameters<DecisionRepository['insertDecision']>[1]) {
    return this.insertDecision(this.db, input);
  }

  async listDecisions(tenantId: string, campaignId: string, limit = 100) {
    return (await this.db.query(`SELECT id,lead_id,call_id,policy_id,policy_version,mode,score,reason_codes,feature_snapshot,fifo_position,suggested_position,final_decision,evaluation_latency_ms,created_at
      FROM call_decisions WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT $3`, [tenantId, campaignId, Math.min(500, Math.max(1, limit))])).rows;
  }

  async latestDecisionForLead(tenantId: string, leadId: string) {
    return (await this.db.query(`SELECT id,lead_id,campaign_id,call_id,policy_id,policy_version,mode,score,reason_codes,feature_snapshot,fifo_position,suggested_position,final_decision,evaluation_latency_ms,created_at
      FROM call_decisions WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT 1`, [tenantId, leadId])).rows[0] ?? null;
  }
}
