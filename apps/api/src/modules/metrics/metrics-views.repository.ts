import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export type SavedViewRow = {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  owner_name?: string;
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class MetricsViewsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(tenantId: string, userId: string): Promise<SavedViewRow[]> {
    const result = await this.db.query(`
      SELECT v.*, u.name AS owner_name
      FROM metric_saved_views v
      JOIN users u ON u.id = v.owner_user_id
      WHERE v.tenant_id = $1 AND (v.owner_user_id = $2 OR v.is_shared = true)
      ORDER BY v.created_at DESC
    `, [tenantId, userId]);
    return result.rows;
  }

  async findById(tenantId: string, id: string): Promise<SavedViewRow | null> {
    const result = await this.db.query(`
      SELECT v.*, u.name AS owner_name FROM metric_saved_views v JOIN users u ON u.id = v.owner_user_id
      WHERE v.tenant_id = $1 AND v.id = $2
    `, [tenantId, id]);
    return result.rows[0] ?? null;
  }

  async insert(input: { id: string; tenantId: string; ownerUserId: string; name: string; filters: unknown; isShared: boolean }) {
    await this.db.query(`
      INSERT INTO metric_saved_views (id, tenant_id, owner_user_id, name, filters, is_shared)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [input.id, input.tenantId, input.ownerUserId, input.name, JSON.stringify(input.filters), input.isShared]);
  }

  async update(tenantId: string, id: string, input: { name?: string; filters?: unknown; isShared?: boolean }) {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) { values.push(input.name); sets.push(`name = $${values.length}`); }
    if (input.filters !== undefined) { values.push(JSON.stringify(input.filters)); sets.push(`filters = $${values.length}::jsonb`); }
    if (input.isShared !== undefined) { values.push(input.isShared); sets.push(`is_shared = $${values.length}`); }
    if (!sets.length) return;
    values.push(tenantId, id);
    await this.db.query(`UPDATE metric_saved_views SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $${values.length - 1} AND id = $${values.length}`, values);
  }

  async remove(tenantId: string, id: string) {
    await this.db.query('DELETE FROM metric_saved_views WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  }
}
