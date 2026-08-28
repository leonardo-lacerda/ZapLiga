import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';

export const slugifyTenant = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

@Injectable()
export class TenantsService {
  constructor(private readonly db: DatabaseService) {}

  async create(name: string, slug?: string) {
    const normalizedSlug = slugifyTenant(slug || name);
    if (!normalizedSlug) throw new ConflictException('Informe um nome ou slug válido para a empresa');
    try {
      const result = await this.db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) RETURNING *', [randomUUID(), name.trim(), normalizedSlug]);
      return result.rows[0];
    } catch (error) {
      if (String(error).includes('tenants_slug_lower_idx')) throw new ConflictException('Já existe uma empresa com este slug');
      throw error;
    }
  }

  async listAll() { return (await this.db.query('SELECT * FROM tenants ORDER BY created_at DESC')).rows; }

  async listForUser(userId: string) {
    return (await this.db.query(`
      SELECT t.id, t.name, t.slug, t.status, tm.role, tm.status AS membership_status
      FROM tenants t
      JOIN tenant_memberships tm ON tm.tenant_id = t.id
      WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status = 'active'
      ORDER BY t.name
    `, [userId])).rows;
  }

  async requireById(id: string) {
    const result = await this.db.query('SELECT * FROM tenants WHERE id = $1', [id]);
    if (!result.rows[0]) throw new NotFoundException('Empresa não encontrada');
    return result.rows[0];
  }

  async setStatus(id: string, status: 'active' | 'blocked' | 'archived') {
    const result = await this.db.transaction(async (client) => {
      const updated = await client.query('UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, id]);
      if (status !== 'active') await client.query(`UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id IN (SELECT user_id FROM tenant_memberships WHERE tenant_id = $1) AND revoked_at IS NULL`, [id]);
      return updated;
    });
    if (!result.rows[0]) throw new NotFoundException('Empresa não encontrada');
    return result.rows[0];
  }

  async setLimits(id: string, limits: { maxLeads?: number; maxNumbers?: number; maxSdrs?: number }) {
    const result = await this.db.query(`
      UPDATE tenants
      SET max_leads = COALESCE($1, max_leads), max_numbers = COALESCE($2, max_numbers), max_sdrs = COALESCE($3, max_sdrs), updated_at = now()
      WHERE id = $4 RETURNING *
    `, [limits.maxLeads ?? null, limits.maxNumbers ?? null, limits.maxSdrs ?? null, id]);
    if (!result.rows[0]) throw new NotFoundException('Empresa nÃ£o encontrada');
    return result.rows[0];
  }
}
