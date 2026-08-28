import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

export type MembershipRole = 'leader' | 'sdr';
export type MembershipStatus = 'active' | 'blocked' | 'removed';

@Injectable()
export class MembershipsService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, userId: string, role: MembershipRole) {
    try {
      const result = await this.db.query(`
        INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [randomUUID(), tenantId, userId, role]);
      return result.rows[0];
    } catch (error) {
      if (String(error).includes('tenant_memberships_tenant_id_user_id_key')) throw new ConflictException('Este usuário já possui uma membership nesta empresa');
      throw error;
    }
  }

  async findForUserInTenant(userId: string, tenantId: string) {
    const result = await this.db.query(`
      SELECT tm.*, t.name AS tenant_name, t.status AS tenant_status
      FROM tenant_memberships tm
      JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND tm.tenant_id = $2
      LIMIT 1
    `, [userId, tenantId]);
    return result.rows[0] ?? null;
  }

  async listForTenant(tenantId: string) {
    return (await this.db.query(`
      SELECT tm.id, tm.tenant_id, tm.user_id, tm.role, tm.status, tm.created_at, tm.updated_at,
        u.name, u.email, u.status AS user_status, u.last_login_at
      FROM tenant_memberships tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1 AND tm.status <> 'removed'
      ORDER BY tm.role, u.name
    `, [tenantId])).rows;
  }

  async listForUser(userId: string) {
    return (await this.db.query(`
      SELECT tm.*, t.name AS tenant_name, t.slug, t.status AS tenant_status
      FROM tenant_memberships tm
      JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND tm.status = 'active'
      ORDER BY t.name
    `, [userId])).rows;
  }

  async findByTenantAndUser(tenantId: string, userId: string) {
    const result = await this.db.query('SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, userId]);
    if (!result.rows[0]) throw new NotFoundException('Membro não encontrado');
    return result.rows[0];
  }

  async setStatus(tenantId: string, userId: string, status: MembershipStatus) {
    const membership = await this.findByTenantAndUser(tenantId, userId);
    if (membership.role === 'leader' && status !== 'active') {
      const leaders = await this.db.query(`SELECT count(*)::int AS count FROM tenant_memberships WHERE tenant_id = $1 AND role = 'leader' AND status = 'active'`, [tenantId]);
      if (Number(leaders.rows[0]?.count ?? 0) <= 1) throw new ConflictException('A empresa precisa manter pelo menos um líder ativo');
    }
    const result = await this.db.transaction(async (client) => {
      const updated = await client.query('UPDATE tenant_memberships SET status = $1, updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [status, tenantId, userId]);
      if (status !== 'active') await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      return updated;
    });
    return result.rows[0];
  }

  async setRole(tenantId: string, userId: string, role: MembershipRole) {
    const membership = await this.findByTenantAndUser(tenantId, userId);
    if (membership.role === 'leader' && role !== 'leader' && membership.status === 'active') {
      const leaders = await this.db.query(`SELECT count(*)::int AS count FROM tenant_memberships WHERE tenant_id = $1 AND role = 'leader' AND status = 'active'`, [tenantId]);
      if (Number(leaders.rows[0]?.count ?? 0) <= 1) throw new ConflictException('A empresa precisa manter pelo menos um líder ativo');
    }
    const result = await this.db.query('UPDATE tenant_memberships SET role = $1, updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [role, tenantId, userId]);
    return result.rows[0];
  }

  async remove(tenantId: string, userId: string) { return this.setStatus(tenantId, userId, 'removed'); }
}
