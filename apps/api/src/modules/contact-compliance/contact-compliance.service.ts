import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

type QueryExecutor = { query: (text: string, params?: any[]) => Promise<any> };

export type SuppressionReason = 'requested_opt_out' | 'invalid_number' | 'legal_restriction' | 'internal_policy' | 'other';
export type SuppressionSource = 'post_call' | 'lead_action' | 'import' | 'admin' | 'api';

export const normalizeContactPhone = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Injectable()
export class ContactComplianceService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private requirePhone(value: unknown) {
    const phone = normalizeContactPhone(value);
    if (phone.length < 10 || phone.length > 15) throw new BadRequestException('Informe um telefone válido com DDD');
    return phone;
  }

  async list(tenantId: string, search = '', limit = 100, offset = 0) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const normalizedSearch = normalizeContactPhone(search);
    const values: unknown[] = [tenantId];
    const searchClause = normalizedSearch ? (values.push(`%${normalizedSearch}%`), `AND s.phone LIKE $${values.length}`) : '';
    const total = await this.db.query(`SELECT count(*)::int AS total FROM contact_suppressions s WHERE s.tenant_id = $1 AND s.lifted_at IS NULL ${searchClause}`, values);
    values.push(safeLimit, safeOffset);
    const items = await this.db.query(`
      SELECT s.*, u.name AS created_by_name,
        (SELECT l.name FROM leads l WHERE l.tenant_id = s.tenant_id AND l.phone = s.phone LIMIT 1) AS lead_name
      FROM contact_suppressions s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.tenant_id = $1 AND s.lifted_at IS NULL ${searchClause}
      ORDER BY s.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }

  async exportAll(tenantId: string) {
    const result = await this.db.query(`SELECT phone, reason, source, notes, created_at FROM contact_suppressions WHERE tenant_id = $1 AND lifted_at IS NULL ORDER BY created_at DESC`, [tenantId]);
    return result.rows;
  }

  async forLead(tenantId: string, leadId: string) {
    const result = await this.db.query(`
      SELECT s.*, u.name AS created_by_name
      FROM leads l
      LEFT JOIN contact_suppressions s ON s.tenant_id = l.tenant_id AND s.phone = l.phone AND s.lifted_at IS NULL
      LEFT JOIN users u ON u.id = s.created_by
      WHERE l.tenant_id = $1 AND l.id = $2
    `, [tenantId, leadId]);
    if (!result.rows[0]) throw new NotFoundException('Lead não encontrado');
    return { suppressed: Boolean(result.rows[0].id), suppression: result.rows[0].id ? result.rows[0] : null };
  }

  async suppress(input: { tenantId: string; phone: unknown; reason: SuppressionReason; source: SuppressionSource; notes?: string; actorUserId?: string | null }) {
    const phone = this.requirePhone(input.phone);
    const suppression = await this.db.transaction((client) => this.suppressWithExecutor(client, { ...input, phone }));
    await this.audit.record({ actorUserId: input.actorUserId, tenantId: input.tenantId, action: 'contact.suppressed', entityType: 'contact_suppression', entityId: suppression.id, metadata: { reason: input.reason, source: input.source } });
    return suppression;
  }

  async suppressWithExecutor(executor: QueryExecutor, input: { tenantId: string; phone: unknown; reason: SuppressionReason; source: SuppressionSource; notes?: string; actorUserId?: string | null }) {
    const phone = this.requirePhone(input.phone);
    const existing = await executor.query('SELECT * FROM contact_suppressions WHERE tenant_id = $1 AND phone = $2 AND lifted_at IS NULL LIMIT 1', [input.tenantId, phone]);
    if (existing.rows[0]) {
      await executor.query('UPDATE leads SET do_not_call = true WHERE tenant_id = $1 AND phone = $2', [input.tenantId, phone]);
      return { ...existing.rows[0], alreadyExisted: true };
    }
    const id = randomUUID();
    let created: any;
    try {
      created = (await executor.query(`
        INSERT INTO contact_suppressions (id, tenant_id, phone, reason, source, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
      `, [id, input.tenantId, phone, input.reason, input.source, input.notes?.trim() || null, input.actorUserId ?? null])).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Este telefone já está na lista de não contato');
      throw error;
    }
    await executor.query('UPDATE leads SET do_not_call = true WHERE tenant_id = $1 AND phone = $2', [input.tenantId, phone]);
    await executor.query(`
      INSERT INTO contact_compliance_events (id, tenant_id, phone, event_type, source, evidence, actor_user_id)
      VALUES ($1, $2, $3, 'opt_out_recorded', $4, $5::jsonb, $6)
    `, [randomUUID(), input.tenantId, phone, input.source, JSON.stringify({ suppressionId: id, reason: input.reason }), input.actorUserId ?? null]);
    return { ...created, alreadyExisted: false };
  }

  async bulkSuppress(tenantId: string, entries: Array<{ phone: string; reason: SuppressionReason; notes?: string }>, actorUserId: string) {
    if (!entries.length) return { imported: 0, existing: 0 };
    const created = await this.db.transaction(async (client) => {
      const inserted: any[] = [];
      const chunkSize = 500;
      for (let offset = 0; offset < entries.length; offset += chunkSize) {
        const chunk = entries.slice(offset, offset + chunkSize);
        const values: unknown[] = [];
        const tuples = chunk.map((entry, index) => {
          const base = index * 7;
          values.push(randomUUID(), tenantId, entry.phone, entry.reason, 'import', entry.notes?.trim() || null, actorUserId);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });
        const result = await client.query(`
          INSERT INTO contact_suppressions (id, tenant_id, phone, reason, source, notes, created_by)
          VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING
          RETURNING id, phone, reason, source
        `, values);
        inserted.push(...result.rows);
      }
      const phones = entries.map((entry) => entry.phone);
      await client.query('UPDATE leads SET do_not_call = true WHERE tenant_id = $1 AND phone = ANY($2::text[])', [tenantId, phones]);
      for (let offset = 0; offset < inserted.length; offset += chunkSize) {
        const chunk = inserted.slice(offset, offset + chunkSize);
        const values: unknown[] = [];
        const tuples = chunk.map((entry, index) => {
          const base = index * 7;
          values.push(randomUUID(), tenantId, entry.phone, 'opt_out_recorded', 'import', JSON.stringify({ suppressionId: entry.id, reason: entry.reason }), actorUserId);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7})`;
        });
        await client.query(`INSERT INTO contact_compliance_events (id, tenant_id, phone, event_type, source, evidence, actor_user_id) VALUES ${tuples.join(',')}`, values);
      }
      return inserted.length;
    });
    const result = { imported: created, existing: entries.length - created };
    await this.audit.record({ actorUserId, tenantId, action: 'contact.suppressions_imported', entityType: 'contact_suppression_import', metadata: result });
    return result;
  }

  async lift(tenantId: string, suppressionId: string, reason: string, actorUserId: string) {
    const cleanReason = reason.trim();
    if (cleanReason.length < 5) throw new BadRequestException('Informe uma justificativa para retirar a supressão');
    const result = await this.db.transaction(async (client) => {
      const found = await client.query('SELECT * FROM contact_suppressions WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, suppressionId]);
      const suppression = found.rows[0];
      if (!suppression) throw new NotFoundException('Supressão não encontrada');
      if (suppression.lifted_at) throw new ConflictException('Esta supressão já foi retirada');
      const lifted = (await client.query(`UPDATE contact_suppressions SET lifted_by = $1, lifted_at = now(), lift_reason = $2 WHERE tenant_id = $3 AND id = $4 RETURNING *`, [actorUserId, cleanReason, tenantId, suppressionId])).rows[0];
      await client.query(`UPDATE leads SET do_not_call = EXISTS (SELECT 1 FROM contact_suppressions s WHERE s.tenant_id = $1 AND s.phone = leads.phone AND s.lifted_at IS NULL) WHERE tenant_id = $1 AND phone = $2`, [tenantId, suppression.phone]);
      await client.query(`
        INSERT INTO contact_compliance_events (id, tenant_id, phone, event_type, source, evidence, actor_user_id)
        VALUES ($1, $2, $3, 'suppression_lifted', 'lead_action', $4::jsonb, $5)
      `, [randomUUID(), tenantId, suppression.phone, JSON.stringify({ suppressionId, reason: cleanReason }), actorUserId]);
      return lifted;
    });
    await this.audit.record({ actorUserId, tenantId, action: 'contact.suppression_lifted', entityType: 'contact_suppression', entityId: suppressionId, metadata: { reason: cleanReason } });
    return result;
  }
}
