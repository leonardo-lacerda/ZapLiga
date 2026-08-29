import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export type ConsistencyIssue = { code: string; description: string; count: number };

type Check = { code: string; description: string; sql: string };

// Cada checagem é independente e tenant-scoped; nenhuma altera dados — só
// reporta. Plano seção 13 (Fase 2): "criar rotina de validação de
// consistência".
const CHECKS: Check[] = [
  {
    code: 'wrap_up_without_connection',
    description: 'Chamadas com pós-atendimento concluído mas sem conexão registrada (connected_at nulo)',
    sql: `SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND wrap_up_completed_at IS NOT NULL AND connected_at IS NULL`,
  },
  {
    code: 'call_result_outside_catalog',
    description: 'Chamadas com call_result fora do catálogo comercial do tenant',
    sql: `SELECT count(*)::int AS count FROM calls c WHERE c.tenant_id = $1 AND c.call_result IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM call_result_catalog cc WHERE cc.tenant_id = c.tenant_id AND cc.id = c.call_result)`,
  },
  {
    code: 'call_pipeline_stage_outside_catalog',
    description: 'Chamadas com pipeline_stage fora do catálogo de etapas do tenant',
    sql: `SELECT count(*)::int AS count FROM calls c WHERE c.tenant_id = $1 AND c.pipeline_stage IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pipeline_stage_catalog pc WHERE pc.tenant_id = c.tenant_id AND pc.id = c.pipeline_stage)`,
  },
  {
    code: 'lead_pipeline_stage_outside_catalog',
    description: 'Leads com pipeline_stage fora do catálogo de etapas do tenant',
    sql: `SELECT count(*)::int AS count FROM leads l WHERE l.tenant_id = $1
      AND NOT EXISTS (SELECT 1 FROM pipeline_stage_catalog pc WHERE pc.tenant_id = l.tenant_id AND pc.id = l.pipeline_stage)`,
  },
  {
    code: 'lead_stage_history_drift',
    description: 'Leads cujo pipeline_stage atual diverge do último registro em lead_stage_history',
    sql: `SELECT count(*)::int AS count FROM leads l WHERE l.tenant_id = $1 AND l.pipeline_stage IS DISTINCT FROM (
        SELECT h.to_stage FROM lead_stage_history h WHERE h.tenant_id = l.tenant_id AND h.lead_id = l.id ORDER BY h.created_at DESC LIMIT 1
      )`,
  },
  {
    code: 'negative_call_duration',
    description: 'Chamadas com duração de toque ou de conexão negativa',
    sql: `SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND (ring_duration_seconds < 0 OR connected_duration_seconds < 0)`,
  },
];

@Injectable()
export class MetricsConsistencyService {
  constructor(private readonly db: DatabaseService) {}

  async check(tenantId: string): Promise<ConsistencyIssue[]> {
    const results = await Promise.all(CHECKS.map((check) => this.db.query(check.sql, [tenantId])));
    return CHECKS
      .map((check, index) => ({ code: check.code, description: check.description, count: Number(results[index].rows[0]?.count ?? 0) }))
      .filter((issue) => issue.count > 0);
  }
}
