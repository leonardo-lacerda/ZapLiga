import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { GoalMetric, GoalScope, GoalValueType } from './metrics.definitions';

// `DatabaseService.query` e `PoolClient.query` (pg) têm conjuntos de
// sobrecarga diferentes; um parâmetro tipado como a união das duas classes
// concretas não tem uma assinatura de chamada compatível. Esta interface
// mínima é só o formato que `insertVia` realmente usa.
type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

export type GoalRow = {
  id: string;
  tenant_id: string;
  scope: GoalScope;
  scope_id: string | null;
  metric: GoalMetric;
  value_type: GoalValueType;
  target_value: string;
  period_from: string;
  period_to: string;
  status: 'active' | 'frozen' | 'archived';
  created_by: string;
  created_by_name?: string;
  scope_name?: string | null;
  created_at: string;
  updated_at: string;
  frozen_at: string | null;
  superseded_by: string | null;
};

export type NewGoalInput = {
  id: string;
  tenantId: string;
  scope: GoalScope;
  scopeId: string | null;
  metric: GoalMetric;
  valueType: GoalValueType;
  targetValue: number;
  periodFrom: string;
  periodTo: string;
  createdBy: string;
};

const SCOPE_NAME_JOIN = `
  LEFT JOIN sdrs sc_s ON sc_s.tenant_id = g.tenant_id AND sc_s.id = g.scope_id AND g.scope = 'sdr'
  LEFT JOIN lead_folders sc_f ON sc_f.tenant_id = g.tenant_id AND sc_f.id = g.scope_id AND g.scope = 'folder'
`;
const SCOPE_NAME_SELECT = `CASE g.scope WHEN 'sdr' THEN sc_s.name WHEN 'folder' THEN sc_f.name ELSE NULL END AS scope_name`;

@Injectable()
export class MetricsGoalsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(tenantId: string, filters: { status?: string; scope?: string; scopeId?: string }): Promise<GoalRow[]> {
    const values: unknown[] = [tenantId];
    const clauses = ['g.tenant_id = $1'];
    if (filters.status) { values.push(filters.status); clauses.push(`g.status = $${values.length}`); }
    else { values.push('archived'); clauses.push(`g.status <> $${values.length}`); }
    if (filters.scope) { values.push(filters.scope); clauses.push(`g.scope = $${values.length}`); }
    if (filters.scopeId) { values.push(filters.scopeId); clauses.push(`g.scope_id = $${values.length}`); }
    const result = await this.db.query(`
      SELECT g.*, u.name AS created_by_name, ${SCOPE_NAME_SELECT}
      FROM metric_goals g
      LEFT JOIN users u ON u.id = g.created_by
      ${SCOPE_NAME_JOIN}
      WHERE ${clauses.join(' AND ')}
      ORDER BY g.created_at DESC
    `, values);
    return result.rows;
  }

  async findById(tenantId: string, id: string): Promise<GoalRow | null> {
    const result = await this.db.query(`
      SELECT g.*, u.name AS created_by_name, ${SCOPE_NAME_SELECT}
      FROM metric_goals g
      LEFT JOIN users u ON u.id = g.created_by
      ${SCOPE_NAME_JOIN}
      WHERE g.tenant_id = $1 AND g.id = $2
    `, [tenantId, id]);
    return result.rows[0] ?? null;
  }

  async findActiveForUpdate(client: PoolClient, tenantId: string, id: string): Promise<GoalRow | null> {
    const result = await client.query(`SELECT * FROM metric_goals WHERE tenant_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`, [tenantId, id]);
    return result.rows[0] ?? null;
  }

  private async insertVia(executor: Queryable, input: NewGoalInput): Promise<GoalRow> {
    const result = await executor.query(`
      INSERT INTO metric_goals (id, tenant_id, scope, scope_id, metric, value_type, target_value, period_from, period_to, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [input.id, input.tenantId, input.scope, input.scopeId, input.metric, input.valueType, input.targetValue, input.periodFrom, input.periodTo, input.createdBy]);
    return result.rows[0];
  }

  insert(input: NewGoalInput): Promise<GoalRow> {
    return this.insertVia(this.db, input);
  }

  insertInTransaction(client: PoolClient, input: NewGoalInput): Promise<GoalRow> {
    return this.insertVia(client, input);
  }

  async freeze(client: PoolClient, tenantId: string, id: string) {
    await client.query(`UPDATE metric_goals SET status = 'frozen', frozen_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [tenantId, id]);
  }

  async linkSuperseded(client: PoolClient, tenantId: string, oldId: string, newId: string) {
    await client.query(`UPDATE metric_goals SET superseded_by = $1 WHERE tenant_id = $2 AND id = $3`, [newId, tenantId, oldId]);
  }

  async archive(tenantId: string, id: string): Promise<GoalRow | null> {
    const result = await this.db.query(`UPDATE metric_goals SET status = 'archived', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING *`, [tenantId, id]);
    return result.rows[0] ?? null;
  }

  async sdrExists(tenantId: string, sdrId: string) {
    const result = await this.db.query('SELECT 1 FROM sdrs WHERE tenant_id = $1 AND id = $2', [tenantId, sdrId]);
    return Boolean(result.rows[0]);
  }

  async folderExists(tenantId: string, folderId: string) {
    const result = await this.db.query('SELECT 1 FROM lead_folders WHERE tenant_id = $1 AND id = $2', [tenantId, folderId]);
    return Boolean(result.rows[0]);
  }

  transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    return this.db.transaction(fn);
  }
}
