import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

const campaignSummaryColumns = `
    c.id, c.tenant_id, c.name, c.description, c.status, c.folder_id,
    c.primary_goal_metric, c.primary_goal_target, c.current_version, c.is_legacy,
    c.started_at, c.paused_at, c.completed_at, c.archived_at, c.created_at, c.updated_at,
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
  JOIN campaign_versions cv
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
}
