import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, NotFoundException, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuthGuard, CurrentTenant, CurrentUser, Roles, RolesGuard, TenantMembershipGuard } from '../auth/auth.guards';
import { parseLeadCsvRow } from './lead-import';
import { CreateLeadDto } from './dto/create-lead.dto';
import { AuditService } from '../audit/audit.service';

const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

@Controller()
@UseGuards(AuthGuard, TenantMembershipGuard, RolesGuard)
@Roles('leader', 'super_admin')
export class LeadsController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Post(['/api/leads', '/api/tenants/:tenantId/leads'])
  async create(@Body() body: CreateLeadDto, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const phone = digits(body.phone);
    if (!phone || !String(body.name ?? '').trim()) throw new BadRequestException('name e phone são obrigatórios');
    const lead = await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
      const [tenant, existing] = await Promise.all([
        client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]),
        client.query('SELECT 1 FROM leads WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [tenantId, phone]),
      ]);
      if (!existing.rows[0]) {
        const count = await client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]);
        if (Number(count.rows[0]?.count ?? 0) >= Number(tenant.rows[0]?.max_leads ?? 100000)) throw new ConflictException('O limite de leads desta empresa foi atingido');
      }
      return (await client.query(`INSERT INTO leads (id,tenant_id,name,phone) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [randomUUID(), tenantId, String(body.name).trim(), phone])).rows[0];
    });
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'lead.created_or_updated', entityType: 'lead', entityId: lead.id });
    return lead;
  }

  @Post(['/api/leads/import', '/api/tenants/:tenantId/leads/import'])
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async import(@UploadedFile() file: Express.Multer.File, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    if (!file?.buffer) throw new BadRequestException('Envie um arquivo CSV no campo file');
    let records: any[];
    try { records = parse(file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true }); }
    catch { throw new BadRequestException('CSV inválido; use as colunas name,phone'); }
    if (records.length > 50_000) throw new BadRequestException('O CSV excede o limite de 50.000 linhas');
    const validLeads: Array<{ name: string; phone: string }> = [];
    let skipped = 0;
    for (const row of records) {
      const lead = parseLeadCsvRow(row);
      if (!lead) {
        skipped++;
        continue;
      }
      validLeads.push(lead);
    }
    const uniquePhones = [...new Set(validLeads.map((lead) => lead.phone))];
    const imported = await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
      const [tenant, current, existing] = await Promise.all([
        client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]),
        client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]),
        uniquePhones.length ? client.query('SELECT phone FROM leads WHERE tenant_id = $1 AND phone = ANY($2::text[])', [tenantId, uniquePhones]) : Promise.resolve({ rows: [] as any[] }),
      ]);
      const existingPhones = new Set(existing.rows.map((row: any) => row.phone));
      const newPhones = uniquePhones.filter((phone) => !existingPhones.has(phone));
      if (Number(current.rows[0]?.count ?? 0) + newPhones.length > Number(tenant.rows[0]?.max_leads ?? 100000)) throw new ConflictException('O CSV excede o limite de leads desta empresa');
      for (const lead of validLeads) await client.query(`INSERT INTO leads (id,tenant_id,name,phone) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, phone) DO UPDATE SET name = EXCLUDED.name`, [randomUUID(), tenantId, lead.name, lead.phone]);
      return validLeads.length;
    });
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'lead.imported', entityType: 'lead_import', metadata: { imported, skipped, total: records.length } });
    return { imported, skipped, total: records.length };
  }

  @Get(['/api/leads', '/api/tenants/:tenantId/leads'])
  list(@Query('status') status: string | undefined, @Query('limit') limit = '100', @Query('offset') offset = '0', @CurrentTenant() tenantId: string) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const params = status ? [tenantId, status, safeLimit, safeOffset] : [tenantId, safeLimit, safeOffset];
    const limitParam = status ? '$3' : '$2';
    const offsetParam = status ? '$4' : '$3';
    return this.db.query(`
      SELECT l.*,
        latest.status AS last_call_status,
        latest.outcome AS last_outcome,
        COALESCE(latest.failure_reason, latest.outcome) AS last_failure_reason,
        latest.created_at AS last_call_at,
        latest.number_label AS last_number_label
      FROM leads l
      LEFT JOIN LATERAL (
        SELECT c.status, c.outcome, c.failure_reason, c.created_at, n.label AS number_label
        FROM calls c
        LEFT JOIN whatsapp_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.number_id
        WHERE c.tenant_id = l.tenant_id AND c.lead_id = l.id
        ORDER BY c.created_at DESC
        LIMIT 1
      ) latest ON true
      WHERE l.tenant_id = $1 ${status ? 'AND l.status = $2' : ''}
      ORDER BY l.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `, params).then((result) => result.rows);
  }

  @Delete(['/api/leads', '/api/tenants/:tenantId/leads'])
  async clear(@CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const active = await this.db.query(`SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND status IN ('reserved', 'dialing', 'media_active')`, [tenantId]);
    if (Number(active.rows[0].count) > 0) throw new BadRequestException('Pause o discador e aguarde as chamadas em andamento terminarem');
    const result = await this.db.transaction(async (client) => {
      const calls = await client.query('DELETE FROM calls WHERE tenant_id = $1', [tenantId]);
      const leads = await client.query('DELETE FROM leads WHERE tenant_id = $1', [tenantId]);
      return { ok: true, deletedLeads: leads.rowCount ?? 0, deletedCalls: calls.rowCount ?? 0 };
    });
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'lead.cleared', entityType: 'lead', metadata: result });
    return result;
  }

  @Delete(['/api/leads/:id', '/api/tenants/:tenantId/leads/:id'])
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const active = await this.db.query(`SELECT status FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, id]);
    if (active.rows[0]) throw new BadRequestException('Pause a chamada antes de remover este lead');
    const result = await this.db.transaction(async (client) => {
      const calls = await client.query('DELETE FROM calls WHERE tenant_id = $1 AND lead_id = $2', [tenantId, id]);
      const lead = await client.query('DELETE FROM leads WHERE tenant_id = $1 AND id = $2 RETURNING id, name, phone', [tenantId, id]);
      if (!lead.rows[0]) throw new NotFoundException('Lead não encontrado');
      return { ok: true, lead: lead.rows[0], deletedCalls: calls.rowCount ?? 0 };
    });
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'lead.removed', entityType: 'lead', entityId: id, metadata: { deletedCalls: result.deletedCalls } });
    return result;
  }

  @Post(['/api/leads/:id/reset', '/api/tenants/:tenantId/leads/:id/reset'])
  async reset(@Param('id') id: string, @CurrentTenant() tenantId: string, @CurrentUser() user: any) {
    const active = await this.db.query(`SELECT status FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, id]);
    if (active.rows[0]) throw new BadRequestException('Não é possível resetar um contato durante uma chamada');
    const result = await this.db.query(`UPDATE leads SET status = 'queued', attempts = 0, next_eligible_at = now(), do_not_call = false WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Lead não encontrado');
    await this.audit.record({ actorUserId: user.id, tenantId, action: 'lead.reset', entityType: 'lead', entityId: id });
    return result.rows[0];
  }
}
