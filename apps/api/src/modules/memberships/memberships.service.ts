import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

export type MembershipRole = 'leader' | 'sdr';
export type MembershipStatus = 'active' | 'blocked' | 'removed';

@Injectable()
export class MembershipsService {
  constructor(private readonly db: DatabaseService) {}

  async create(tenantId: string, userId: string, role: MembershipRole) {
    return this.db.transaction(async (client) => {
      const existing = await client.query('SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE', [tenantId, userId]);
      if (existing.rows[0] && existing.rows[0].status !== 'removed') throw new ConflictException('Este usuário já possui uma membership nesta empresa');
      const membership = existing.rows[0]
        ? (await client.query('UPDATE tenant_memberships SET role = $1, status = \'active\', updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [role, tenantId, userId])).rows[0]
        : (await client.query('INSERT INTO tenant_memberships (id, tenant_id, user_id, role) VALUES ($1, $2, $3, $4) RETURNING *', [randomUUID(), tenantId, userId, role])).rows[0];
      if (role === 'sdr') {
        const sdr = await client.query('SELECT id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1', [tenantId, userId]);
        if (!sdr.rows[0]) {
          const quota = await client.query(`SELECT t.max_sdrs, count(tm.user_id)::int AS current
            FROM tenants t
            LEFT JOIN sdrs s ON s.tenant_id = t.id
            LEFT JOIN tenant_memberships tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active'
            WHERE t.id = $1 GROUP BY t.id, t.max_sdrs`, [tenantId]);
          if (Number(quota.rows[0]?.current ?? 0) >= Number(quota.rows[0]?.max_sdrs ?? 500)) throw new ConflictException('O limite de SDRs desta empresa foi atingido');
          const name = await client.query('SELECT name FROM users WHERE id = $1', [userId]);
          await client.query('INSERT INTO sdrs (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4)', [randomUUID(), tenantId, userId, name.rows[0]?.name ?? 'SDR']);
        }
      }
      return membership;
    });
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

  async listForTenant(tenantId: string, role?: MembershipRole, limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const values: unknown[] = [tenantId];
    let roleClause = '';
    if (role) { values.push(role); roleClause = `AND tm.role = $${values.length}`; }
    const total = await this.db.query(`
      SELECT count(*)::int AS total
      FROM tenant_memberships tm
      WHERE tm.tenant_id = $1 AND tm.status <> 'removed' ${roleClause}
    `, values);
    values.push(safeLimit, safeOffset);
    const items = await this.db.query(`
      SELECT tm.id, tm.tenant_id, tm.user_id, tm.role, tm.status, tm.created_at, tm.updated_at,
        u.name, u.email, u.status AS user_status, u.last_login_at
      FROM tenant_memberships tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1 AND tm.status <> 'removed' ${roleClause}
      ORDER BY tm.role, u.name
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
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
      // Serialize leader demotions/removals per tenant so two concurrent
      // requests cannot both observe the last leader and leave the company
      // without an active leader.
      if (membership.role === 'leader' && status !== 'active') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`membership-leader:${tenantId}`]);
        const leaders = await client.query(`SELECT count(*)::int AS count FROM tenant_memberships WHERE tenant_id = $1 AND role = 'leader' AND status = 'active'`, [tenantId]);
        if (Number(leaders.rows[0]?.count ?? 0) <= 1) throw new ConflictException('A empresa precisa manter pelo menos um líder ativo');
      }
      const updated = await client.query('UPDATE tenant_memberships SET status = $1, updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [status, tenantId, userId]);
      if (status !== 'active') {
        const remaining = await client.query(`SELECT count(*)::int AS count FROM tenant_memberships tm JOIN tenants t ON t.id = tm.tenant_id WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active'`, [userId]);
        if (Number(remaining.rows[0]?.count ?? 0) === 0) await client.query('UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      }
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
    const result = await this.db.transaction(async (client) => {
      if (membership.role === 'leader' && role !== 'leader' && membership.status === 'active') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`membership-leader:${tenantId}`]);
        const lockedLeaders = await client.query(`SELECT count(*)::int AS count FROM tenant_memberships WHERE tenant_id = $1 AND role = 'leader' AND status = 'active'`, [tenantId]);
        if (Number(lockedLeaders.rows[0]?.count ?? 0) <= 1) throw new ConflictException('A empresa precisa manter pelo menos um lÃ­der ativo');
      }
      return client.query('UPDATE tenant_memberships SET role = $1, updated_at = now() WHERE tenant_id = $2 AND user_id = $3 RETURNING *', [role, tenantId, userId]);
    });
    return result.rows[0];
  }

  async remove(tenantId: string, userId: string) { return this.setStatus(tenantId, userId, 'removed'); }
}
