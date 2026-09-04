import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';

type QueryExecutor = Pick<PoolClient, 'query'>;

const campaignSummaryColumns = `
    c.id, c.tenant_id, c.name, c.description, c.status, c.folder_id,
    c.primary_goal_metric, c.primary_goal_target, c.current_version, c.is_legacy,
    c.started_at, c.paused_at, c.completed_at, c.archived_at, c.created_at, c.updated_at,
    c.lock_version, c.draft_config, c.published_at,
    f.name AS folder_name,
    cv.config_hash AS current_version_hash,
    cv.created_at AS current_version_created_at,
    (SELECT count(*)::int FROM campaign_sdrs cs
      WHERE cs.tenant_id = c.tenant_id AND cs.campaign_id = c.id) AS sdr_count,
    (SELECT count(*)::int FROM campaign_numbers cn
      WHERE cn.tenant_id = c.tenant_id AND cn.campaign_id = c.id) AS number_count,
    CASE WHEN c.is_legacy
      THEN (SELECT count(*)::int FROM leads l WHERE l.tenant_id = c.tenant_id)
      ELSE (SELECT count(*)::int FROM leads l WHERE l.tenant_id = c.tenant_id AND l.folder_id = c.folder_id)
    END AS lead_count`;

const campaignFrom = `
  FROM campaigns c
  LEFT JOIN lead_folders f ON f.tenant_id = c.tenant_id AND f.id = c.folder_id
  LEFT JOIN campaign_versions cv
    ON cv.tenant_id = c.tenant_id AND cv.campaign_id = c.id AND cv.version = c.current_version
`;

@Injectable()
export class CampaignsRepository {
  constructor(private readonly db: DatabaseService) {}

  async list(tenantId: string, status: string | undefined, limit: number, offset: number) {
    const statusClause = status ? 'AND c.status = $2' : '';
    const baseParams: unknown[] = status ? [tenantId, status] : [tenantId];
    const total = await this.db.query(
      `SELECT count(*)::int AS total FROM campaigns c WHERE c.tenant_id = $1 ${statusClause}`,
      baseParams,
    );
    const items = await this.db.query(
      `SELECT ${campaignSummaryColumns}
       ${campaignFrom}
       WHERE c.tenant_id = $1 ${statusClause}
       ORDER BY c.is_legacy DESC, c.updated_at DESC, c.id ASC
       LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
      [...baseParams, limit, offset],
    );
    return {
      items: items.rows,
      total: Number(total.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  }

  async findById(tenantId: string, campaignId: string) {
    const result = await this.db.query(
      `SELECT ${campaignSummaryColumns},
        cv.config_snapshot AS current_config,
        cv.change_reason AS current_version_reason,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('id', s.id, 'name', s.name, 'state', s.state, 'available', s.available)
            ORDER BY s.name, s.id
          )
          FROM campaign_sdrs cs
          JOIN sdrs s ON s.tenant_id = cs.tenant_id AND s.id = cs.sdr_id
          WHERE cs.tenant_id = c.tenant_id AND cs.campaign_id = c.id
        ), '[]'::jsonb) AS sdrs,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('id', n.id, 'label', n.label, 'status', n.status)
            ORDER BY n.label, n.id
          )
          FROM campaign_numbers cn
          JOIN whatsapp_numbers n ON n.tenant_id = cn.tenant_id AND n.id = cn.number_id
          WHERE cn.tenant_id = c.tenant_id AND cn.campaign_id = c.id
        ), '[]'::jsonb) AS numbers
       ${campaignFrom}
       WHERE c.tenant_id = $1 AND c.id = $2
       LIMIT 1`,
      [tenantId, campaignId],
    );
    return result.rows[0];
  }

  async findForUpdate(client: QueryExecutor, tenantId: string, campaignId: string) {
    return (await client.query('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, campaignId])).rows[0];
  }

  async findDefaultFolderId(client: QueryExecutor, tenantId: string) {
    return (await client.query('SELECT id FROM lead_folders WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order, created_at, id LIMIT 1', [tenantId])).rows[0]?.id as string | undefined;
  }

  async resourceOwnership(client: QueryExecutor, tenantId: string, folderId: string, sdrIds: string[], numberIds: string[]) {
    const result = await client.query(`SELECT
      EXISTS (SELECT 1 FROM lead_folders WHERE tenant_id = $1 AND id = $2) AS folder_exists,
      (SELECT count(*)::int FROM sdrs WHERE tenant_id = $1 AND id = ANY($3::text[])) AS sdr_count,
      (SELECT count(*)::int FROM whatsapp_numbers WHERE tenant_id = $1 AND id = ANY($4::text[]) AND status <> 'removed') AS number_count`,
    [tenantId, folderId, sdrIds, numberIds]);
    return result.rows[0];
  }

  async createDraft(client: QueryExecutor, input: {
    id: string; tenantId: string; userId: string; name: string; description?: string | null; folderId: string;
    primaryGoalMetric?: string | null; primaryGoalTarget?: number | null; config: Record<string, unknown>;
  }) {
    return (await client.query(`INSERT INTO campaigns (
      id, tenant_id, name, description, status, folder_id, primary_goal_metric,
      primary_goal_target, current_version, is_legacy, draft_config, created_by, updated_by
    ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, NULL, false, $8::jsonb, $9, $9)
    RETURNING *`, [input.id, input.tenantId, input.name, input.description ?? null, input.folderId,
      input.primaryGoalMetric ?? null, input.primaryGoalTarget ?? null, JSON.stringify(input.config), input.userId])).rows[0];
  }

  async updateDraft(client: QueryExecutor, tenantId: string, campaignId: string, input: {
    name: string; description?: string | null; folderId: string; primaryGoalMetric?: string | null;
    primaryGoalTarget?: number | null; config: Record<string, unknown>; status: string; userId: string;
  }) {
    return (await client.query(`UPDATE campaigns SET
      name = $3, description = $4, folder_id = $5, primary_goal_metric = $6,
      primary_goal_target = $7, draft_config = $8::jsonb, status = $9,
      lock_version = lock_version + 1, updated_by = $10, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, campaignId, input.name,
      input.description ?? null, input.folderId, input.primaryGoalMetric ?? null,
      input.primaryGoalTarget ?? null, JSON.stringify(input.config), input.status, input.userId])).rows[0];
  }

  async replaceAssociations(client: QueryExecutor, tenantId: string, campaignId: string, sdrIds: string[], numberIds: string[]) {
    await client.query('DELETE FROM campaign_sdrs WHERE tenant_id = $1 AND campaign_id = $2', [tenantId, campaignId]);
    await client.query('DELETE FROM campaign_numbers WHERE tenant_id = $1 AND campaign_id = $2', [tenantId, campaignId]);
    if (sdrIds.length) await client.query(`INSERT INTO campaign_sdrs (tenant_id, campaign_id, sdr_id)
      SELECT $1, $2, unnest($3::text[])`, [tenantId, campaignId, sdrIds]);
    if (numberIds.length) await client.query(`INSERT INTO campaign_numbers (tenant_id, campaign_id, number_id)
      SELECT $1, $2, unnest($3::text[])`, [tenantId, campaignId, numberIds]);
  }

  async definition(client: QueryExecutor, tenantId: string, campaignId: string) {
    return (await client.query(`SELECT c.*, cv.config_snapshot AS published_config,
      COALESCE((SELECT jsonb_agg(cs.sdr_id ORDER BY cs.sdr_id) FROM campaign_sdrs cs WHERE cs.tenant_id = c.tenant_id AND cs.campaign_id = c.id), '[]'::jsonb) AS sdr_ids,
      COALESCE((SELECT jsonb_agg(cn.number_id ORDER BY cn.number_id) FROM campaign_numbers cn WHERE cn.tenant_id = c.tenant_id AND cn.campaign_id = c.id), '[]'::jsonb) AS number_ids
      FROM campaigns c
      LEFT JOIN campaign_versions cv ON cv.tenant_id = c.tenant_id AND cv.campaign_id = c.id AND cv.version = c.current_version
      WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, campaignId])).rows[0];
  }

  async insertVersion(client: QueryExecutor, input: {
    id: string; tenantId: string; campaignId: string; version: number; snapshot: unknown;
    hash: string; reason?: string | null; userId: string; lockVersion: number;
  }) {
    await client.query(`INSERT INTO campaign_versions (
      id, tenant_id, campaign_id, version, config_snapshot, config_hash, change_reason,
      created_by, published_from_lock_version
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`, [input.id, input.tenantId,
      input.campaignId, input.version, JSON.stringify(input.snapshot), input.hash,
      input.reason ?? null, input.userId, input.lockVersion]);
  }

  async publish(client: QueryExecutor, tenantId: string, campaignId: string, version: number, userId: string, incrementLock = true) {
    return (await client.query(`UPDATE campaigns SET current_version = $3, status = CASE WHEN status = 'running' THEN 'running' ELSE 'ready' END,
      published_at = now(), updated_by = $4, updated_at = now(), lock_version = lock_version + $5
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, campaignId, version, userId, incrementLock ? 1 : 0])).rows[0];
  }

  async transition(client: QueryExecutor, tenantId: string, campaignId: string, status: string, userId: string) {
    return (await client.query(`UPDATE campaigns SET status = $3,
      started_at = CASE WHEN $3 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
      paused_at = CASE WHEN $3 = 'paused' THEN now() WHEN $3 = 'running' THEN NULL ELSE paused_at END,
      completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
      archived_at = CASE WHEN $3 = 'archived' THEN now() ELSE archived_at END,
      lock_version = lock_version + 1, updated_by = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, campaignId, status, userId])).rows[0];
  }

  async listVersions(tenantId: string, campaignId: string) {
    return (await this.db.query(`SELECT id, version, config_hash, change_reason, created_by,
      published_from_lock_version, created_at FROM campaign_versions
      WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY version DESC`, [tenantId, campaignId])).rows;
  }

  async findVersion(tenantId: string, campaignId: string, version: number) {
    return (await this.db.query(`SELECT id, tenant_id, campaign_id, version, config_snapshot,
      config_hash, change_reason, created_by, published_from_lock_version, created_at
      FROM campaign_versions WHERE tenant_id = $1 AND campaign_id = $2 AND version = $3`,
    [tenantId, campaignId, version])).rows[0];
  }
}
