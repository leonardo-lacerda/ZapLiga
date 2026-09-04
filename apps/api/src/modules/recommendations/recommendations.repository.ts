import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RecommendationEventType, RecommendationStatus } from './recommendations.types';

type QueryExecutor = { query: (text: string, params?: unknown[]) => Promise<any> };

@Injectable()
export class RecommendationsRepository {
  constructor(private readonly db: DatabaseService) {}

  async sync(tenantId: string, candidates: Array<Record<string, any>>, observedAt: string) {
    const activeCodes = candidates.map((candidate) => candidate.code);
    const synced: any[] = [];
    for (const candidate of candidates) {
      const id = `${tenantId}:${candidate.code}:${candidate.scopeKey}`;
      const row = (await this.db.query(`
        INSERT INTO operation_recommendations
          (id, tenant_id, campaign_id, code, scope_key, status, severity, title_key, evidence, recommended_action, action_type, action_payload, confidence, impact_scope, rule_version, fingerprint, expires_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,$16,now())
        ON CONFLICT (tenant_id, code, scope_key) DO UPDATE SET
          campaign_id=EXCLUDED.campaign_id,
          status=CASE WHEN operation_recommendations.status IN ('dismissed', 'snoozed') AND operation_recommendations.fingerprint = EXCLUDED.fingerprint THEN operation_recommendations.status ELSE 'active' END,
          severity=EXCLUDED.severity,
          title_key=EXCLUDED.title_key,
          evidence=EXCLUDED.evidence,
          recommended_action=EXCLUDED.recommended_action,
          action_type=EXCLUDED.action_type,
          action_payload=EXCLUDED.action_payload,
          confidence=EXCLUDED.confidence,
          impact_scope=EXCLUDED.impact_scope,
          rule_version=EXCLUDED.rule_version,
          fingerprint=EXCLUDED.fingerprint,
          expires_at=EXCLUDED.expires_at,
          updated_at=now()
        RETURNING *
      `, [
        id, tenantId, candidate.campaignId, candidate.code, candidate.scopeKey, candidate.severity, candidate.title,
        JSON.stringify(candidate.evidence), JSON.stringify(candidate.recommendedAction), candidate.recommendedAction.type,
        JSON.stringify(candidate.recommendedAction.payload), candidate.confidence, candidate.impactScope, candidate.ruleVersion,
        `${candidate.code}:${JSON.stringify(candidate.evidence)}`, candidate.expiresAt,
      ])).rows[0];
      synced.push(row);
    }
    if (activeCodes.length) {
      await this.db.query(`UPDATE operation_recommendations SET status='resolved', resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND status IN ('active','snoozed') AND code NOT LIKE 'operation_health_%' AND NOT (code = ANY($2::text[]))`, [tenantId, activeCodes]);
    } else {
      await this.db.query(`UPDATE operation_recommendations SET status='resolved', resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND status IN ('active','snoozed') AND code NOT LIKE 'operation_health_%'`, [tenantId]);
    }
    return synced;
  }

  async list(tenantId: string, status?: RecommendationStatus, limit = 3) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 3)));
    const values: unknown[] = [tenantId];
    const statusClause = status ? `AND status = $${values.push(status)}` : `AND status IN ('active','snoozed')`;
    values.push(safeLimit);
    return (await this.db.query(`SELECT * FROM operation_recommendations WHERE tenant_id=$1 ${statusClause} AND (expires_at IS NULL OR expires_at > now()) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, updated_at DESC LIMIT $${values.length}`, values)).rows;
  }

  async get(tenantId: string, id: string) {
    return (await this.db.query('SELECT * FROM operation_recommendations WHERE tenant_id=$1 AND id=$2', [tenantId, id])).rows[0] ?? null;
  }

  async updateStatus(tenantId: string, id: string, status: Extract<RecommendationStatus, 'snoozed' | 'dismissed' | 'resolved'>, snoozedUntil?: string | null, executor: QueryExecutor = this.db) {
    return (await executor.query(`UPDATE operation_recommendations SET status=$3, snoozed_until=$4, resolved_at=CASE WHEN $3='resolved' THEN now() ELSE resolved_at END, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status IN ('active','snoozed') RETURNING *`, [tenantId, id, status, snoozedUntil ?? null])).rows[0] ?? null;
  }

  async recordEvent(tenantId: string, recommendationId: string, eventType: RecommendationEventType, actorUserId: string, metadata: Record<string, unknown> = {}, executor: QueryExecutor = this.db) {
    return (await executor.query(`INSERT INTO recommendation_events (id, tenant_id, recommendation_id, event_type, actor_user_id, recommendation_status, metadata)
      SELECT $1, $2, $3, $4, $5, status, $6::jsonb FROM operation_recommendations WHERE tenant_id=$2 AND id=$3 RETURNING *`, [randomUUID(), tenantId, recommendationId, eventType, actorUserId, JSON.stringify(metadata)])).rows[0] ?? null;
  }

  async history(tenantId: string, recommendationId?: string, limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    if (recommendationId) return (await this.db.query('SELECT * FROM recommendation_events WHERE tenant_id=$1 AND recommendation_id=$2 ORDER BY created_at DESC LIMIT $3', [tenantId, recommendationId, safeLimit])).rows;
    return (await this.db.query('SELECT * FROM recommendation_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2', [tenantId, safeLimit])).rows;
  }
}
