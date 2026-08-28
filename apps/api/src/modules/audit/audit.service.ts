import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

export type AuditInput = {
  actorUserId?: string | null;
  tenantId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  async record(input: AuditInput) {
    await this.db.query(`
      INSERT INTO audit_logs (id, actor_user_id, tenant_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `, [randomUUID(), input.actorUserId ?? null, input.tenantId ?? null, input.action, input.entityType ?? null, input.entityId ?? null, JSON.stringify(input.metadata ?? {}), input.ipAddress ?? null, input.userAgent?.slice(0, 500) ?? null]);
  }

  async list(limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    return (await this.db.query(`
      SELECT a.*, u.name AS actor_name, u.email AS actor_email, t.name AS tenant_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN tenants t ON t.id = a.tenant_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [safeLimit, safeOffset])).rows;
  }

  async listForTenant(tenantId: string, limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    return (await this.db.query(`
      SELECT a.*, u.name AS actor_name, u.email AS actor_email, t.name AS tenant_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.tenant_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2 OFFSET $3
    `, [tenantId, safeLimit, safeOffset])).rows;
  }
}
