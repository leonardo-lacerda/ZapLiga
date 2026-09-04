import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { HealthResult } from './health-formula';

@Injectable()
export class HealthRecommendationsAdapter {
  constructor(private readonly db: DatabaseService) {}

  async sync(tenantId: string, result: HealthResult, evidence: Record<string, unknown>, observedAt: string) {
    const recommendations = await this.db.query(`SELECT recommendations FROM tenant_feature_flags WHERE tenant_id = $1`, [tenantId]);
    const enabled = recommendations.rows[0]?.recommendations === true;
    const codes = ['operation_health_risk', 'operation_health_blocked'];
    if (!enabled || !['degraded', 'blocked', 'attention'].includes(result.state)) {
      await this.db.query(`UPDATE operation_recommendations SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE tenant_id = $1 AND code = ANY($2::text[]) AND status IN ('active','snoozed')`, [tenantId, codes]);
      return { created: false, reason: enabled ? 'health_not_actionable' : 'recommendations_disabled' };
    }
    const code = result.state === 'blocked' ? 'operation_health_blocked' : 'operation_health_risk';
    const title = result.state === 'blocked' ? 'Operação bloqueada por política' : 'Saúde da operação exige atenção';
    const action = { label: 'Ver saúde da operação', description: 'Abra o diagnóstico antes de alterar o ritmo da discagem.', type: 'navigate', payload: { tab: 'operation-health' } };
    const evidencePayload = { source: 'operation_health', observedAt, score: result.score, state: result.state, reasonCodes: result.reasonCodes, components: result.components, aggregate: evidence };
    const fingerprint = `${code}:${result.formulaVersion}:${result.reasonCodes.join(',')}:${result.score}`;
    await this.db.query(`
      INSERT INTO operation_recommendations
        (id, tenant_id, code, scope_key, status, severity, title_key, evidence, recommended_action, action_type, action_payload, confidence, impact_scope, rule_version, fingerprint)
      VALUES ($1, $2, $3, 'tenant', 'active', $4, $5, $6::jsonb, $7::jsonb, 'navigate', $8::jsonb, $9, 'tenant', 1, $10)
      ON CONFLICT (tenant_id, code, scope_key) DO UPDATE SET
        status = CASE WHEN operation_recommendations.status IN ('dismissed','snoozed') AND operation_recommendations.fingerprint = EXCLUDED.fingerprint THEN operation_recommendations.status ELSE 'active' END,
        severity = EXCLUDED.severity,
        title_key = EXCLUDED.title_key,
        evidence = EXCLUDED.evidence,
        recommended_action = EXCLUDED.recommended_action,
        action_type = EXCLUDED.action_type,
        action_payload = EXCLUDED.action_payload,
        confidence = EXCLUDED.confidence,
        fingerprint = EXCLUDED.fingerprint,
        updated_at = now()
    `, [
      `${tenantId}:${code}:tenant`, tenantId, code, result.state === 'blocked' ? 'critical' : 'warning', title,
      JSON.stringify(evidencePayload), JSON.stringify(action), JSON.stringify(action.payload), Math.min(1, Math.max(0.1, result.score / 100)), fingerprint,
    ]);
    const otherCode = code === codes[0] ? codes[1] : codes[0];
    await this.db.query(`UPDATE operation_recommendations SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE tenant_id = $1 AND code = $2 AND status IN ('active','snoozed')`, [tenantId, otherCode]);
    return { created: true, code };
  }
}
