import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export type ExportJobRow = {
  id: string;
  tenant_id: string;
  requested_by: string;
  dataset: string;
  format: 'csv' | 'pdf';
  status: 'processing' | 'completed' | 'failed';
  row_count: number | null;
  file_name: string | null;
  content_type: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ExportFileRow = { file_name: string; content_type: string; file_data: Buffer; status: string };

@Injectable()
export class MetricsExportRepository {
  constructor(private readonly db: DatabaseService) {}

  async createJob(input: { id: string; tenantId: string; requestedBy: string; dataset: string; format: 'csv' | 'pdf'; filters: unknown }) {
    await this.db.query(`
      INSERT INTO metric_exports (id, tenant_id, requested_by, dataset, format, filters)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `, [input.id, input.tenantId, input.requestedBy, input.dataset, input.format, JSON.stringify(input.filters)]);
  }

  async complete(id: string, input: { rowCount: number; fileName: string; contentType: string; fileData: Buffer }) {
    await this.db.query(`
      UPDATE metric_exports SET status = 'completed', row_count = $2, file_name = $3, content_type = $4, file_data = $5, completed_at = now()
      WHERE id = $1
    `, [id, input.rowCount, input.fileName, input.contentType, input.fileData]);
  }

  async fail(id: string, errorMessage: string) {
    await this.db.query(`UPDATE metric_exports SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1`, [id, errorMessage.slice(0, 500)]);
  }

  async findById(tenantId: string, id: string): Promise<ExportJobRow | null> {
    const result = await this.db.query(`
      SELECT id, tenant_id, requested_by, dataset, format, status, row_count, file_name, content_type, error_message, created_at, completed_at
      FROM metric_exports WHERE tenant_id = $1 AND id = $2
    `, [tenantId, id]);
    return result.rows[0] ?? null;
  }

  async findFileById(tenantId: string, id: string): Promise<ExportFileRow | null> {
    const result = await this.db.query(`SELECT file_name, content_type, file_data, status FROM metric_exports WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return result.rows[0] ?? null;
  }
}
