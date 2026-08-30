import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { parseLeadCsvRow } from '../leads/lead-import';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const activeCallStatuses = "('reserved', 'dialing', 'media_active')";

@Injectable()
export class LeadFoldersService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  async list(tenantId: string) {
    const result = await this.db.query(`
      SELECT f.*,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id) AS lead_count,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id
          AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait')
          AND l.next_eligible_at <= now() AND l.attempts < COALESCE(ds.max_attempts_per_lead, 2)) AS ready_count,
        (SELECT count(*)::int FROM calls c WHERE c.tenant_id = f.tenant_id AND c.folder_id = f.id
          AND c.status IN ${activeCallStatuses}) AS active_call_count
      FROM lead_folders f
      LEFT JOIN dialer_settings ds ON ds.tenant_id = f.tenant_id
      WHERE f.tenant_id = $1
      ORDER BY f.sort_order ASC, f.created_at ASC
    `, [tenantId]);
    return result.rows;
  }

  async get(folderId: string, tenantId: string) {
    const result = await this.db.query(`
      SELECT f.*,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id) AS lead_count,
        (SELECT count(*)::int FROM leads l WHERE l.tenant_id = f.tenant_id AND l.folder_id = f.id
          AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait')
          AND l.next_eligible_at <= now() AND l.attempts < COALESCE(ds.max_attempts_per_lead, 2)) AS ready_count,
        (SELECT count(*)::int FROM calls c WHERE c.tenant_id = f.tenant_id AND c.folder_id = f.id
          AND c.status IN ${activeCallStatuses}) AS active_call_count
      FROM lead_folders f
      LEFT JOIN dialer_settings ds ON ds.tenant_id = f.tenant_id
      WHERE f.tenant_id = $1 AND f.id = $2
    `, [tenantId, folderId]);
    if (!result.rows[0]) throw new NotFoundException('Pasta de leads não encontrada');
    return result.rows[0];
  }

  async create(input: { name: string; isActive?: boolean }, tenantId: string, userId: string) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da pasta deve ter entre 2 e 80 caracteres');
    try {
      const result = await this.db.query(`
        INSERT INTO lead_folders (id, tenant_id, name, is_active, created_by, sort_order)
        VALUES ($1, $2, $3, $4, $5, COALESCE((SELECT max(sort_order) + 1 FROM lead_folders WHERE tenant_id = $2), 0))
        RETURNING *
      `, [randomUUID(), tenantId, name, input.isActive !== false, userId]);
      const folder = result.rows[0];
      await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_folder.created', entityType: 'lead_folder', entityId: folder.id, metadata: { name: folder.name } });
      return this.get(folder.id, tenantId);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Já existe uma pasta com este nome');
      throw error;
    }
  }

  async update(folderId: string, input: { name?: string; isActive?: boolean; sortOrder?: number }, tenantId: string, userId: string) {
    const current = await this.get(folderId, tenantId);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da pasta deve ter entre 2 e 80 caracteres');
      values.push(name); sets.push(`name = $${values.length}`);
    }
    if (input.sortOrder !== undefined) {
      values.push(Math.max(0, Math.floor(Number(input.sortOrder)))); sets.push(`sort_order = $${values.length}`);
    }
    if (input.isActive !== undefined) {
      values.push(Boolean(input.isActive)); sets.push(`is_active = $${values.length}`);
      sets.push(`deactivated_at = CASE WHEN $${values.length} THEN NULL ELSE COALESCE(deactivated_at, now()) END`);
    }
    if (!sets.length) return current;
    values.push(tenantId, folderId);
    try {
      await this.db.query(`UPDATE lead_folders SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $${values.length - 1} AND id = $${values.length}`, values);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Já existe uma pasta com este nome');
      throw error;
    }
    const updated = await this.get(folderId, tenantId);
    if (input.isActive !== undefined && Boolean(input.isActive) !== Boolean(current.is_active)) {
      await this.audit.record({ actorUserId: userId, tenantId, action: input.isActive ? 'lead_folder.activated' : 'lead_folder.deactivated', entityType: 'lead_folder', entityId: folderId });
    }
    if (input.name !== undefined && input.name.trim() !== current.name) {
      await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_folder.renamed', entityType: 'lead_folder', entityId: folderId, metadata: { name: updated.name } });
    }
    return updated;
  }

  async remove(folderId: string, tenantId: string, userId: string) {
    const folder = await this.get(folderId, tenantId);
    const leads = await this.db.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1 AND folder_id = $2', [tenantId, folderId]);
    if (Number(leads.rows[0]?.count ?? 0) > 0) throw new ConflictException('Mova ou limpe os leads antes de excluir esta pasta');
    await this.db.query('DELETE FROM lead_folders WHERE tenant_id = $1 AND id = $2', [tenantId, folderId]);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_folder.archived', entityType: 'lead_folder', entityId: folderId, metadata: { name: folder.name } });
    return { ok: true, id: folderId };
  }

  async listLeads(folderId: string, tenantId: string, status?: string, limit = '100', offset = '0') {
    await this.get(folderId, tenantId);
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const baseParams = status ? [tenantId, folderId, status] : [tenantId, folderId];
    const statusClause = status ? 'AND l.status = $3' : '';
    const limitParam = status ? '$4' : '$3';
    const offsetParam = status ? '$5' : '$4';
    const total = await this.db.query(`
      SELECT count(*)::int AS total FROM leads l
      WHERE l.tenant_id = $1 AND l.folder_id = $2 ${statusClause}
    `, baseParams);
    const items = await this.db.query(`
      SELECT l.*, f.name AS folder_name, f.is_active AS folder_is_active,
        latest.status AS last_call_status, latest.outcome AS last_outcome,
        COALESCE(latest.failure_reason, latest.outcome) AS last_failure_reason,
        latest.created_at AS last_call_at, latest.number_label AS last_number_label
      FROM leads l
      JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
      LEFT JOIN LATERAL (
        SELECT c.status, c.outcome, c.failure_reason, c.created_at, n.label AS number_label
        FROM calls c LEFT JOIN whatsapp_numbers n ON n.id = c.number_id
        WHERE c.tenant_id = l.tenant_id AND c.lead_id = l.id
        ORDER BY c.created_at DESC LIMIT 1
      ) latest ON true
      WHERE l.tenant_id = $1 AND l.folder_id = $2 ${statusClause}
      ORDER BY l.created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}
    `, [...baseParams, safeLimit, safeOffset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }

  async createLead(folderId: string, input: { name: string; phone: string }, tenantId: string, userId: string) {
    const name = String(input.name ?? '').trim();
    const phone = digits(input.phone);
    if (!name || !phone) throw new BadRequestException('name e phone são obrigatórios');
    await this.get(folderId, tenantId);
    const lead = await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
      const existing = await client.query('SELECT id, folder_id FROM leads WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [tenantId, phone]);
      if (existing.rows[0] && existing.rows[0].folder_id !== folderId) throw new ConflictException('Este telefone já está em outra pasta');
      const tenant = await client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]);
      if (!existing.rows[0]) {
        const count = await client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]);
        if (Number(count.rows[0]?.count ?? 0) >= Number(tenant.rows[0]?.max_leads ?? 100000)) throw new ConflictException('O limite de leads desta empresa foi atingido');
      }
      return (await client.query(`
        INSERT INTO leads (id, tenant_id, folder_id, name, phone)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name, folder_id = EXCLUDED.folder_id
        RETURNING *
      `, [randomUUID(), tenantId, folderId, name, phone])).rows[0];
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead.created_or_updated', entityType: 'lead', entityId: lead.id, metadata: { folderId } });
    return lead;
  }

  async import(folderId: string, file: Express.Multer.File, tenantId: string, userId: string) {
    if (!file?.buffer) throw new BadRequestException('Envie um arquivo CSV no campo file');
    await this.get(folderId, tenantId);
    let records: Record<string, unknown>[];
    try { records = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true }); }
    catch { throw new BadRequestException('CSV inválido; use as colunas name,phone'); }
    if (records.length > 50_000) throw new BadRequestException('O CSV excede o limite de 50.000 linhas');
    let skipped = 0;
    let duplicated = 0;
    const parsed = new Map<string, { name: string; phone: string }>();
    for (const row of records) {
      const lead = parseLeadCsvRow(row);
      if (!lead) { skipped++; continue; }
      if (parsed.has(lead.phone)) duplicated++;
      else parsed.set(lead.phone, lead);
    }
    const validLeads = [...parsed.values()];
    const result = await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
      const [tenant, current, existing] = await Promise.all([
        client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]),
        client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]),
        validLeads.length ? client.query('SELECT phone, folder_id FROM leads WHERE tenant_id = $1 AND phone = ANY($2::text[])', [tenantId, validLeads.map((lead) => lead.phone)]) : Promise.resolve({ rows: [] as any[] }),
      ]);
      const existingByPhone = new Map(existing.rows.map((row: any) => [row.phone, row]));
      const newLeads = validLeads.filter((lead) => !existingByPhone.has(lead.phone));
      if (Number(current.rows[0]?.count ?? 0) + newLeads.length > Number(tenant.rows[0]?.max_leads ?? 100000)) throw new ConflictException('O CSV excede o limite de leads desta empresa');
      const sameFolderExisting = validLeads.filter((lead) => existingByPhone.get(lead.phone)?.folder_id === folderId);
      duplicated += validLeads.filter((lead) => existingByPhone.get(lead.phone)?.folder_id && existingByPhone.get(lead.phone)?.folder_id !== folderId).length;
      const insertLeads = newLeads;

      // Update and insert in bounded multi-row statements. The old loop held
      // the transaction while issuing one round-trip per CSV row, which made a
      // 50k import monopolize a database connection for a long time.
      const chunkSize = 500;
      let updated = 0;
      for (let offset = 0; offset < sameFolderExisting.length; offset += chunkSize) {
        const chunk = sameFolderExisting.slice(offset, offset + chunkSize);
        const values: unknown[] = [];
        const tuples = chunk.map((lead, index) => {
          const base = index * 3;
          values.push(lead.phone, lead.name, tenantId);
          return `($${base + 1}, $${base + 2}, $${base + 3})`;
        });
        const result = await client.query(`
          UPDATE leads AS l
          SET name = data.name
          FROM (VALUES ${tuples.join(',')}) AS data(phone, name, tenant_id)
          WHERE l.tenant_id = data.tenant_id AND l.phone = data.phone
        `, values);
        updated += result.rowCount ?? 0;
      }

      let imported = 0;
      for (let offset = 0; offset < insertLeads.length; offset += chunkSize) {
        const chunk = insertLeads.slice(offset, offset + chunkSize);
        const values: unknown[] = [];
        const tuples = chunk.map((lead, index) => {
          const base = index * 5;
          values.push(randomUUID(), tenantId, folderId, lead.name, lead.phone);
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });
        const result = await client.query(`
          INSERT INTO leads (id, tenant_id, folder_id, name, phone)
          VALUES ${tuples.join(',')}
          ON CONFLICT (tenant_id, phone) DO NOTHING
        `, values);
        imported += result.rowCount ?? 0;
      }
      return { imported, updated, duplicated, skipped, total: records.length };
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_folder.imported', entityType: 'lead_import', entityId: folderId, metadata: result });
    return result;
  }

  async clear(folderId: string, tenantId: string, userId: string) {
    await this.get(folderId, tenantId);
    const active = await this.db.query(`SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND folder_id = $2 AND status IN ${activeCallStatuses}`, [tenantId, folderId]);
    if (Number(active.rows[0]?.count ?? 0) > 0) throw new BadRequestException('Pause o discador e aguarde as chamadas em andamento terminarem');
    const result = await this.db.transaction(async (client) => {
      const calls = await client.query('DELETE FROM calls WHERE tenant_id = $1 AND folder_id = $2', [tenantId, folderId]);
      const leads = await client.query('DELETE FROM leads WHERE tenant_id = $1 AND folder_id = $2', [tenantId, folderId]);
      return { ok: true, deletedLeads: leads.rowCount ?? 0, deletedCalls: calls.rowCount ?? 0 };
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_folder.cleared', entityType: 'lead_folder', entityId: folderId, metadata: result });
    return result;
  }

  async metrics(folderId: string, tenantId: string, from?: string, to?: string) {
    await this.get(folderId, tenantId);
    const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : new Date().toISOString();
    const startDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const start = startDate.toISOString();
    const [leadCounts, calls, outcomes, pipeline, lastImport] = await Promise.all([
      this.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'retry_wait')::int AS retry_wait, count(*) FILTER (WHERE status = 'completed')::int AS completed, count(*) FILTER (WHERE do_not_call)::int AS do_not_call FROM leads WHERE tenant_id = $1 AND folder_id = $2`, [tenantId, folderId]),
      this.db.query(`SELECT count(*)::int AS attempts, count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered, count(*) FILTER (WHERE status = 'no_answer')::int AS no_answer, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'completed')::int AS completed, count(*) FILTER (WHERE status IN ${activeCallStatuses})::int AS active FROM calls WHERE tenant_id = $1 AND folder_id = $2 AND created_at >= $3 AND created_at <= $4`, [tenantId, folderId, start, end]),
      this.db.query(`SELECT COALESCE(outcome, status) AS label, count(*)::int AS count FROM calls WHERE tenant_id = $1 AND folder_id = $2 AND created_at >= $3 AND created_at <= $4 GROUP BY COALESCE(outcome, status) ORDER BY count DESC`, [tenantId, folderId, start, end]),
      this.db.query(`SELECT COALESCE(pipeline_stage, 'Sem etapa') AS label, count(*)::int AS count FROM calls WHERE tenant_id = $1 AND folder_id = $2 AND created_at >= $3 AND created_at <= $4 GROUP BY COALESCE(pipeline_stage, 'Sem etapa') ORDER BY count DESC`, [tenantId, folderId, start, end]),
      this.db.query(`SELECT metadata, created_at FROM audit_logs WHERE tenant_id = $1 AND action = 'lead_folder.imported' AND entity_id = $2 ORDER BY created_at DESC LIMIT 1`, [tenantId, folderId]),
    ]);
    const lead = leadCounts.rows[0] ?? {};
    const call = calls.rows[0] ?? {};
    const attempts = Number(call.attempts ?? 0);
    const answered = Number(call.answered ?? 0);
    return {
      from: start,
      to: end,
      leads: { total: Number(lead.total ?? 0), queued: Number(lead.queued ?? 0), retry_wait: Number(lead.retry_wait ?? 0), completed: Number(lead.completed ?? 0), do_not_call: Number(lead.do_not_call ?? 0) },
      calls: { attempts, answered, answer_rate: attempts ? Math.round((answered / attempts) * 100) : 0, no_answer: Number(call.no_answer ?? 0), failed: Number(call.failed ?? 0), completed: Number(call.completed ?? 0), active: Number(call.active ?? 0) },
      outcomes: outcomes.rows,
      pipeline: pipeline.rows,
      last_import: lastImport.rows[0] ?? null,
    };
  }
}
