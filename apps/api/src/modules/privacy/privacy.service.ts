import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { normalizeContactPhone } from '../contact-compliance/contact-compliance.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Injectable()
export class PrivacyService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, @Optional() private readonly redis?: RedisService) {}
  private get secret() { return process.env.DATA_PROTECTION_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'development-data-protection-key'; }
  private phoneHash(phone: string) { return createHmac('sha256', this.secret).update(phone).digest('hex'); }
  private encrypt(value: string) { const key = createHash('sha256').update(this.secret).digest(); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`; }
  private decrypt(value: string) { const [iv, tag, body] = value.split('.'); const key = createHash('sha256').update(this.secret).digest(); const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'); }

  onModuleInit() { this.timer = setInterval(() => void this.processPending().catch(() => undefined), 60_000); void this.processPending().catch(() => undefined); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private normalize(phone: string) {
    const normalized = normalizeContactPhone(phone);
    if (normalized.length < 10 || normalized.length > 15) throw new BadRequestException('Telefone inválido');
    return normalized;
  }

  async subject(tenantId: string, rawPhone: string) {
    const phone = this.normalize(rawPhone);
    const [leads, calls, suppressions, callbacks] = await Promise.all([
      this.db.query(`SELECT id, folder_id, name, phone, status, pipeline_stage, attempts, do_not_call, created_at FROM leads WHERE tenant_id = $1 AND phone = $2`, [tenantId, phone]),
      this.db.query(`SELECT c.id, c.status, c.outcome, c.call_result, c.pipeline_stage, c.notes, c.source, c.created_at, c.ended_at FROM calls c JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id WHERE c.tenant_id = $1 AND l.phone = $2 ORDER BY c.created_at DESC`, [tenantId, phone]),
      this.db.query(`SELECT id, reason, source, notes, created_at, lifted_at FROM contact_suppressions WHERE tenant_id = $1 AND phone = $2 ORDER BY created_at DESC`, [tenantId, phone]),
      this.db.query(`SELECT cb.id, cb.due_at, cb.status, cb.notes, cb.created_at FROM lead_callbacks cb JOIN leads l ON l.tenant_id = cb.tenant_id AND l.id = cb.lead_id WHERE cb.tenant_id = $1 AND l.phone = $2 ORDER BY cb.created_at DESC`, [tenantId, phone]),
    ]);
    return { phone, found: Boolean(leads.rows.length || calls.rows.length || suppressions.rows.length), sources: { leads: leads.rows, calls: calls.rows, suppressions: suppressions.rows, callbacks: callbacks.rows }, uses: ['operação do discador', 'histórico comercial', ...(suppressions.rows.length ? ['prevenção de contato indevido'] : [])] };
  }

  async createRequest(tenantId: string, rawPhone: string, requestType: string, details: string | undefined, userId: string) {
    const phone = this.normalize(rawPhone); const id = randomUUID();
    await this.db.transaction(async (client) => {
      await client.query(`INSERT INTO data_subject_requests (id, tenant_id, request_type, subject_phone_hash, subject_phone_encrypted, requested_by_user_id, details_encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, tenantId, requestType, this.phoneHash(phone), this.encrypt(phone), userId, details?.trim() ? this.encrypt(details.trim()) : null]);
      await client.query(`INSERT INTO data_subject_request_events (request_id, tenant_id, actor_user_id, event_type, metadata) VALUES ($1,$2,$3,'created',$4)`, [id, tenantId, userId, { requestType }]);
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'privacy.request_created', entityType: 'data_subject_request', entityId: id, metadata: { requestType } });
    return this.getRequest(tenantId, id);
  }

  async list(tenantId: string) {
    const rows = (await this.db.query(`SELECT r.*, u.name AS requested_by_name FROM data_subject_requests r LEFT JOIN users u ON u.id = r.requested_by_user_id WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT 500`, [tenantId])).rows;
    return rows.map((row) => ({ ...row, subject_phone_masked: `••••${this.decrypt(row.subject_phone_encrypted).slice(-4)}`, subject_phone_encrypted: undefined, details: undefined, details_encrypted: undefined, has_details: Boolean(row.details || row.details_encrypted) }));
  }

  async getRequest(tenantId: string, id: string) { const row = (await this.db.query('SELECT * FROM data_subject_requests WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0]; if (!row) throw new NotFoundException('Solicitação não encontrada'); return { ...row, subject_phone_masked: `••••${this.decrypt(row.subject_phone_encrypted).slice(-4)}`, subject_phone_encrypted: undefined, details: undefined, details_encrypted: undefined, has_details: Boolean(row.details || row.details_encrypted) }; }

  async startProcessing(tenantId: string, id: string, userId: string) {
    const result = await this.db.query(`UPDATE data_subject_requests SET status = 'processing', assigned_to_user_id = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3 AND status = 'open' RETURNING id`, [userId, tenantId, id]);
    if (!result.rows[0]) { const existing = await this.getRequest(tenantId, id); if (existing.status === 'completed') return existing; if (existing.status !== 'processing') throw new BadRequestException('Solicitação não pode ser processada'); }
    await this.db.query(`INSERT INTO data_subject_request_events (request_id, tenant_id, actor_user_id, event_type) VALUES ($1,$2,$3,'processing_started')`, [id, tenantId, userId]);
    try { await this.processOne(tenantId, id, userId); }
    catch (error) { await this.redis?.incrementMetric('privacy_jobs_failed_total'); throw error; }
    return this.getRequest(tenantId, id);
  }

  async reject(tenantId: string, id: string, reason: string, userId: string) {
    const result = await this.db.query(`UPDATE data_subject_requests SET status = 'rejected', completed_at = now(), updated_at = now(), assigned_to_user_id = $1 WHERE tenant_id = $2 AND id = $3 AND status IN ('open','processing') RETURNING id`, [userId, tenantId, id]); if (!result.rows[0]) throw new BadRequestException('Solicitação já encerrada');
    await this.db.query(`INSERT INTO data_subject_request_events (request_id, tenant_id, actor_user_id, event_type, metadata) VALUES ($1,$2,$3,'rejected',$4)`, [id, tenantId, userId, { reason }]);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'privacy.request_rejected', entityType: 'data_subject_request', entityId: id, metadata: { reason } }); return this.getRequest(tenantId, id);
  }

  private async processPending() { const rows = await this.db.query(`SELECT tenant_id, id, assigned_to_user_id FROM data_subject_requests WHERE status = 'processing' ORDER BY updated_at LIMIT 20`); for (const row of rows.rows) await this.processOne(row.tenant_id, row.id, row.assigned_to_user_id).catch(async () => { await this.redis?.incrementMetric('privacy_jobs_failed_total'); }); await this.db.query('DELETE FROM data_subject_exports WHERE expires_at <= now()'); }

  private async processOne(tenantId: string, id: string, userId?: string) {
    await this.db.transaction(async (client) => {
      const result = await client.query(`SELECT * FROM data_subject_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]); const request = result.rows[0]; if (!request || request.status === 'completed') return; if (request.status !== 'processing') throw new BadRequestException('Solicitação não está em processamento');
      const phone = this.decrypt(request.subject_phone_encrypted);
      const leads = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
      if (request.request_type === 'export') {
        const payload = await this.exportPayload(client, tenantId, phone);
        await client.query(`INSERT INTO data_subject_exports (request_id, tenant_id, payload) VALUES ($1,$2,$3) ON CONFLICT (request_id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = now() + interval '24 hours'`, [id, tenantId, payload]);
      } else if (request.request_type === 'anonymization' || request.request_type === 'deletion') {
        for (const lead of leads.rows) await client.query(`UPDATE leads SET name = 'Titular anonimizado', phone = $1, do_not_call = true WHERE tenant_id = $2 AND id = $3`, [`anon${createHash('sha256').update(`${tenantId}:${lead.id}`).digest('hex').slice(0, 18)}`, tenantId, lead.id]);
        await client.query(`UPDATE calls SET notes = NULL WHERE tenant_id = $1 AND lead_id = ANY($2::text[])`, [tenantId, leads.rows.map((lead) => lead.id)]);
        await client.query(`UPDATE lead_callbacks SET notes = NULL WHERE tenant_id = $1 AND lead_id = ANY($2::text[])`, [tenantId, leads.rows.map((lead) => lead.id)]);
        await client.query(`UPDATE contact_suppressions SET notes = NULL WHERE tenant_id = $1 AND phone = $2`, [tenantId, phone]);
      } else if (request.request_type === 'correction') {
        let correction: any; try { correction = JSON.parse(request.details_encrypted ? this.decrypt(request.details_encrypted) : request.details ?? '{}'); } catch { throw new BadRequestException('Detalhes de correção devem ser JSON'); }
        const newPhone = correction.phone ? this.normalize(correction.phone) : null;
        if (newPhone && newPhone !== phone) {
          const suppression = (await client.query(`SELECT reason FROM contact_suppressions WHERE tenant_id = $1 AND phone = $2 AND lifted_at IS NULL LIMIT 1`, [tenantId, phone])).rows[0];
          if (suppression) await client.query(`INSERT INTO contact_suppressions (id, tenant_id, phone, reason, source) VALUES ($1,$2,$3,$4,'api') ON CONFLICT DO NOTHING`, [randomUUID(), tenantId, newPhone, suppression.reason]);
          await client.query(`INSERT INTO contact_compliance_events (id, tenant_id, phone, event_type, source, evidence, actor_user_id) VALUES ($1,$2,$3,'data_corrected','privacy_request',$4,$5)`, [randomUUID(), tenantId, newPhone, { requestId: id, previousPhoneHash: this.phoneHash(phone) }, userId ?? null]);
        }
        for (const lead of leads.rows) await client.query(`UPDATE leads SET name = COALESCE($1, name), phone = COALESCE($2, phone), do_not_call = CASE WHEN $2::text IS NULL THEN do_not_call ELSE EXISTS (SELECT 1 FROM contact_suppressions s WHERE s.tenant_id = $3 AND s.phone = $2 AND s.lifted_at IS NULL) END WHERE tenant_id = $3 AND id = $4`, [correction.name?.trim() || null, newPhone, tenantId, lead.id]);
      }
      await client.query(`UPDATE data_subject_requests SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await client.query(`INSERT INTO data_subject_request_events (request_id, tenant_id, actor_user_id, event_type, metadata) VALUES ($1,$2,$3,'completed',$4)`, [id, tenantId, userId ?? null, { requestType: request.request_type, matchedLeads: leads.rows.length }]);
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'privacy.request_completed', entityType: 'data_subject_request', entityId: id });
  }

  private async exportPayload(client: any, tenantId: string, phone: string) {
    const query = async (sql: string) => (await client.query(sql, [tenantId, phone])).rows;
    return { generatedAt: new Date().toISOString(), tenantId, subject: { phone }, leads: await query('SELECT id,name,phone,status,pipeline_stage,attempts,created_at FROM leads WHERE tenant_id = $1 AND phone = $2'), calls: await query('SELECT c.id,c.status,c.outcome,c.call_result,c.pipeline_stage,c.notes,c.source,c.created_at,c.ended_at FROM calls c JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_id WHERE c.tenant_id=$1 AND l.phone=$2'), suppressions: await query('SELECT reason,source,notes,created_at,lifted_at FROM contact_suppressions WHERE tenant_id=$1 AND phone=$2') };
  }

  async downloadExport(tenantId: string, requestId: string, userId: string) {
    const result = await this.db.query(`UPDATE data_subject_exports SET downloaded_at = now() WHERE tenant_id = $1 AND request_id = $2 AND expires_at > now() RETURNING payload, expires_at`, [tenantId, requestId]); if (!result.rows[0]) throw new NotFoundException('Exportação inexistente ou expirada');
    await this.audit.record({ actorUserId: userId, tenantId, action: 'privacy.export_downloaded', entityType: 'data_subject_request', entityId: requestId }); return result.rows[0].payload;
  }
}
