import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { connect, AckPolicy, DeliverPolicy, JetStreamClient, JetStreamManager, NatsConnection, StringCodec } from 'nats';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { decryptSecret, encryptSecret, hashCredential, safeEqual, webhookSignature } from './lead-ingestion.crypto';

type IntegrationType = 'webhook' | 'api' | 'automation';
type DuplicatePolicy = 'update_existing' | 'ignore_duplicate' | 'reject_duplicate';
type CanonicalLead = { externalId?: string; name: string; phone: string; email?: string; priority: number; metadata: Record<string, unknown> };

const SUBJECT = 'zapliga.lead-ingestion';
const STREAM = 'ZAPLIGA_LEAD_INGESTION';
const CONSUMER = 'lead-ingestion-worker';
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const publicOrigin = () => String(process.env.PUBLIC_API_ORIGIN ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',')[0].trim().replace(/\/$/, '');
const webhookUrl = (publicId: string) => `${publicOrigin()}/api/v1/lead-integrations/${publicId}/webhook`;

@Injectable()
export class LeadIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadIngestionService.name);
  private readonly codec = StringCodec();
  private nats?: NatsConnection;
  private jetstream?: JetStreamClient;
  private manager?: JetStreamManager;
  private publisherTimer?: NodeJS.Timeout;
  private consumerRunning = false;

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.publisherTimer = setInterval(() => void this.flushOutbox(), 1000);
    void this.flushOutbox();
  }

  async onModuleDestroy() {
    if (this.publisherTimer) clearInterval(this.publisherTimer);
    await this.nats?.drain().catch(() => undefined);
  }

  private async natsReady() {
    if (!this.nats) {
      this.nats = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222', name: 'zapliga-lead-ingestion' });
      this.jetstream = this.nats.jetstream();
      this.manager = await this.nats.jetstreamManager();
      try { await this.manager.streams.add({ name: STREAM, subjects: [SUBJECT], retention: 'limits' as any, storage: 'file' as any, max_msgs: -1 }); } catch { /* stream already exists */ }
      try {
        await this.manager.consumers.add(STREAM, { durable_name: CONSUMER, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: SUBJECT, max_deliver: 5, ack_wait: 60_000_000_000 });
      } catch { /* consumer already exists */ }
    }
    return { nats: this.nats, jetstream: this.jetstream!, manager: this.manager! };
  }

  private publicIntegration(row: any) {
    return {
      id: row.id, public_id: row.public_id, name: row.name, integration_type: row.integration_type,
      status: row.status, default_folder_id: row.default_folder_id, duplicate_policy: row.duplicate_policy,
      default_priority: row.default_priority, field_mapping: row.field_mapping ?? {}, last_received_at: row.last_received_at,
      last_success_at: row.last_success_at, last_error_at: row.last_error_at, created_at: row.created_at, revoked_at: row.revoked_at,
      api_key_prefix: row.api_key_prefix,
    };
  }

  private createWebhookUrl(publicId: string) {
    return webhookUrl(publicId);
  }

  async list(tenantId: string) {
    const result = await this.db.query('SELECT * FROM lead_integrations WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    return result.rows.map((row) => this.publicIntegration(row));
  }

  async create(tenantId: string, userId: string, input: { name: string; integrationType?: IntegrationType; defaultFolderId: string; duplicatePolicy?: DuplicatePolicy; defaultPriority?: number; fieldMapping?: Record<string, string> }) {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da integração deve ter entre 2 e 80 caracteres');
    const folder = await this.db.query('SELECT id, is_active FROM lead_folders WHERE tenant_id = $1 AND id = $2', [tenantId, input.defaultFolderId]);
    if (!folder.rows[0]) throw new BadRequestException('A pasta padrão não pertence a esta empresa');
    if (!folder.rows[0].is_active) throw new BadRequestException('A pasta padrão precisa estar ativa');
    const apiKey = `zpl_in_${randomBytes(30).toString('base64url')}`;
    const signingSecret = `zpl_sig_${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query(`INSERT INTO lead_integrations
      (id, tenant_id, public_id, name, integration_type, default_folder_id, duplicate_policy, default_priority, field_mapping, api_key_prefix, api_key_hash, signing_secret_ciphertext, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) RETURNING *`, [
      randomUUID(), tenantId, `li_${randomBytes(12).toString('hex')}`, name, input.integrationType ?? 'webhook', input.defaultFolderId,
      input.duplicatePolicy ?? 'update_existing', Math.max(-100, Math.min(100, Number(input.defaultPriority ?? 0))), JSON.stringify(input.fieldMapping ?? {}),
      apiKey.slice(0, 16), hashCredential(apiKey), encryptSecret(signingSecret), userId,
    ])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_integration.created', entityType: 'lead_integration', entityId: row.id });
    return { ...this.publicIntegration(row), api_key: apiKey, signing_secret: signingSecret, webhook_url: this.createWebhookUrl(row.public_id) };
  }

  async update(tenantId: string, userId: string, id: string, input: { name?: string; defaultFolderId?: string; duplicatePolicy?: DuplicatePolicy; defaultPriority?: number; fieldMapping?: Record<string, string> }) {
    const current = await this.findForTenant(tenantId, id);
    const folderId = input.defaultFolderId ?? current.default_folder_id;
    const folder = await this.db.query('SELECT id, is_active FROM lead_folders WHERE tenant_id = $1 AND id = $2', [tenantId, folderId]);
    if (!folder.rows[0] || !folder.rows[0].is_active) throw new BadRequestException('A pasta padrão precisa pertencer à empresa e estar ativa');
    const name = input.name === undefined ? current.name : String(input.name).trim();
    if (name.length < 2 || name.length > 80) throw new BadRequestException('O nome da integração deve ter entre 2 e 80 caracteres');
    const row = (await this.db.query(`UPDATE lead_integrations SET name=$1, default_folder_id=$2, duplicate_policy=$3, default_priority=$4, field_mapping=$5::jsonb, updated_at=now()
      WHERE tenant_id=$6 AND id=$7 RETURNING *`, [name, folderId, input.duplicatePolicy ?? current.duplicate_policy, Math.max(-100, Math.min(100, Number(input.defaultPriority ?? current.default_priority))), JSON.stringify(input.fieldMapping ?? current.field_mapping ?? {}), tenantId, id])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_integration.updated', entityType: 'lead_integration', entityId: id });
    return this.publicIntegration(row);
  }

  async revoke(tenantId: string, userId: string, id: string) {
    await this.findForTenant(tenantId, id);
    const result = await this.db.query(`UPDATE lead_integrations SET status='revoked', revoked_at=COALESCE(revoked_at,now()), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, id]);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_integration.revoked', entityType: 'lead_integration', entityId: id });
    return this.publicIntegration(result.rows[0]);
  }

  async rotate(tenantId: string, userId: string, id: string) {
    const current = await this.findForTenant(tenantId, id);
    if (current.status !== 'active') throw new ConflictException('A integração está revogada');
    const apiKey = `zpl_in_${randomBytes(30).toString('base64url')}`;
    const signingSecret = `zpl_sig_${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query(`UPDATE lead_integrations SET api_key_prefix=$1, api_key_hash=$2, signing_secret_ciphertext=$3, updated_at=now() WHERE tenant_id=$4 AND id=$5 RETURNING *`, [apiKey.slice(0, 16), hashCredential(apiKey), encryptSecret(signingSecret), tenantId, id])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'lead_integration.rotated', entityType: 'lead_integration', entityId: id });
    return { ...this.publicIntegration(row), api_key: apiKey, signing_secret: signingSecret, webhook_url: this.createWebhookUrl(row.public_id) };
  }

  private async findForTenant(tenantId: string, id: string) {
    const result = await this.db.query('SELECT * FROM lead_integrations WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (!result.rows[0]) throw new NotFoundException('Integração não encontrada');
    return result.rows[0];
  }

  private async authenticate(publicId: string, request: any) {
    const result = await this.db.query('SELECT * FROM lead_integrations WHERE public_id = $1 AND status = \'active\'', [publicId]);
    const integration = result.rows[0];
    if (!integration) throw new UnauthorizedException('Integração inválida ou revogada');
    const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(JSON.stringify(request.body ?? {}));
    const apiKeyHeader = String(request.headers['x-zapliga-api-key'] ?? request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
    const timestamp = String(request.headers['x-zapliga-timestamp'] ?? '');
    const signatureHeader = String(request.headers['x-zapliga-signature'] ?? '').replace(/^sha256=/i, '');
    let authenticated = Boolean(apiKeyHeader) && safeEqual(hashCredential(apiKeyHeader), String(integration.api_key_hash));
    if (!authenticated && timestamp && signatureHeader && integration.signing_secret_ciphertext) {
      const timestampMs = Number(timestamp) * 1000;
      if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) throw new UnauthorizedException('Assinatura expirada');
      authenticated = safeEqual(webhookSignature(decryptSecret(integration.signing_secret_ciphertext), timestamp, rawBody), signatureHeader);
    }
    if (!authenticated) throw new UnauthorizedException('Credencial da integração inválida');
    const ip = String(request.ip ?? request.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
    const rateKey = `zapliga:lead-ingestion:rate:${integration.id}:${ip}`;
    const count = await this.redis.client.incr(rateKey);
    if (count === 1) await this.redis.client.expire(rateKey, 60);
    if (count > 100) throw new HttpException('Limite de requisições da integração atingido', HttpStatus.TOO_MANY_REQUESTS);
    return integration;
  }

  private readPath(input: unknown, path: string) {
    return path.split('.').reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, input);
  }

  normalizePayload(payload: unknown, mapping: Record<string, string> = {}, defaultPriority = 0): CanonicalLead {
    if (!isRecord(payload)) throw new BadRequestException('O payload do lead deve ser um objeto JSON');
    const value = (key: string, aliases: string[]) => {
      if (mapping[key]) return this.readPath(payload, mapping[key]);
      for (const alias of [key, ...aliases]) {
        const candidate = this.readPath(payload, alias);
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
      }
      return undefined;
    };
    const name = String(value('name', ['full_name', 'nome', 'Nome completo', 'contact.name']) ?? '').trim();
    const phone = digits(value('phone', ['telefone', 'mobile', 'celular', 'phone_number', 'contact.phone']));
    if (name.length < 2) throw new BadRequestException('O lead precisa de um nome válido');
    if (phone.length < 10 || phone.length > 15) throw new BadRequestException('O lead precisa de um telefone válido com DDD');
    const emailValue = value('email', ['e-mail', 'mail', 'contact.email']);
    const externalValue = value('external_id', ['externalId', 'id', 'contact.id']);
    const priorityValue = Number(value('priority', ['queue_priority']) ?? defaultPriority);
    return {
      name, phone, email: emailValue ? String(emailValue).trim().slice(0, 320) : undefined,
      externalId: externalValue ? String(externalValue).trim().slice(0, 200) : undefined,
      priority: Number.isFinite(priorityValue) ? Math.max(-100, Math.min(100, Math.trunc(priorityValue))) : Math.max(-100, Math.min(100, defaultPriority)),
      metadata: isRecord(payload.metadata) ? payload.metadata : {},
    };
  }

  async accept(publicId: string, request: any, batch = false) {
    const integration = await this.authenticate(publicId, request);
    const raw = request.body;
    const items = batch ? (Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.leads) ? raw.leads : null) : [raw];
    if (!items || !items.length || items.length > 100) throw new BadRequestException('Envie entre 1 e 100 leads no lote');
    const normalized = items.map((item) => this.normalizePayload(item, integration.field_mapping ?? {}, Number(integration.default_priority ?? 0)));
    const baseKey = String(request.headers['idempotency-key'] ?? '').trim().slice(0, 200);
    const results: Array<{ event_id: string; status: string }> = [];
    await this.db.transaction(async (client) => {
      for (let index = 0; index < normalized.length; index += 1) {
        const lead = normalized[index];
        const idempotencyKey = baseKey ? (normalized.length === 1 ? baseKey : `${baseKey}:${index}`) : createHash('sha256').update(JSON.stringify(lead)).digest('hex');
        const eventId = randomUUID();
        const externalEventId = lead.externalId ?? null;
        const payload = JSON.stringify(items[index]);
        const existingEvent = await client.query(`SELECT id, status FROM lead_ingestion_events
          WHERE integration_id=$1 AND (idempotency_key=$2 OR ($3::text IS NOT NULL AND external_event_id=$3)) LIMIT 1`, [integration.id, idempotencyKey, externalEventId]);
        if (existingEvent.rows[0]) {
          results.push({ event_id: existingEvent.rows[0].id, status: existingEvent.rows[0].status });
          continue;
        }
        const inserted = await client.query(`INSERT INTO lead_ingestion_events
          (id, tenant_id, integration_id, idempotency_key, external_event_id, payload_hash, payload, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'received')
          ON CONFLICT (integration_id, idempotency_key) DO NOTHING RETURNING id, status`, [eventId, integration.tenant_id, integration.id, idempotencyKey, externalEventId, createHash('sha256').update(payload).digest('hex'), payload]);
        if (!inserted.rows[0]) {
          const existing = await client.query(`SELECT id, status FROM lead_ingestion_events
            WHERE integration_id=$1 AND (idempotency_key=$2 OR ($3::text IS NOT NULL AND external_event_id=$3)) LIMIT 1`, [integration.id, idempotencyKey, externalEventId]);
          results.push({ event_id: existing.rows[0].id, status: existing.rows[0].status });
          continue;
        }
        await client.query(`INSERT INTO lead_ingestion_outbox (id, tenant_id, event_id, subject, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`, [randomUUID(), integration.tenant_id, eventId, SUBJECT, JSON.stringify({ eventId })]);
        results.push({ event_id: eventId, status: 'received' });
      }
      await client.query('UPDATE lead_integrations SET last_received_at = now(), updated_at = now() WHERE id = $1', [integration.id]);
    });
    void this.flushOutbox();
    return { accepted: results.filter((item) => item.status === 'received').length, duplicate: results.filter((item) => item.status !== 'received').length, events: results };
  }

  private async flushOutbox() {
    try {
      const { jetstream } = await this.natsReady();
      const rows = (await this.db.query(`SELECT id, event_id, subject, payload FROM lead_ingestion_outbox WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT 25`)).rows;
      for (const row of rows) {
        try {
          await jetstream.publish(row.subject, this.codec.encode(JSON.stringify(row.payload)), { msgID: row.event_id });
          await this.db.query(`UPDATE lead_ingestion_outbox SET status='published', published_at=now(), attempts=attempts+1 WHERE id=$1 AND status='pending'`, [row.id]);
        } catch (error) {
          await this.db.query(`UPDATE lead_ingestion_outbox SET attempts=attempts+1, next_attempt_at=now() + (LEAST(300, GREATEST(5, attempts * 5)) * interval '1 second'), last_error=$2, status=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id=$1`, [row.id, String(error).slice(0, 300)]).catch(() => undefined);
        }
      }
      await this.consume();
    } catch { /* NATS remains optional for boot; the outbox retries on the next tick. */ }
  }

  private async consume() {
    if (this.consumerRunning) return;
    this.consumerRunning = true;
    try {
      const { jetstream } = await this.natsReady();
      const consumer = await jetstream.consumers.get(STREAM, CONSUMER);
      const messages = await consumer.consume({ max_messages: 10, expires: 1000 });
      for await (const message of messages) {
        try {
          const parsed = JSON.parse(this.codec.decode(message.data)) as { eventId: string };
          await this.processEvent(parsed.eventId);
          message.ack();
        } catch (error) {
          this.logger.error(`Falha ao processar evento de ingestão: ${String(error).slice(0, 300)}`);
          message.nak(5000);
        }
      }
      await messages.close();
    } catch { /* consumer is recreated/retried by the next outbox tick */ }
    finally { this.consumerRunning = false; }
  }

  async processEvent(eventId: string) {
    const event = (await this.db.query(`SELECT e.*, i.default_folder_id, i.duplicate_policy, i.default_priority, i.field_mapping, i.status AS integration_status
      FROM lead_ingestion_events e JOIN lead_integrations i ON i.tenant_id=e.tenant_id AND i.id=e.integration_id WHERE e.id=$1`, [eventId])).rows[0];
    if (!event) return;
    if (['accepted', 'updated', 'duplicate', 'rejected'].includes(event.status)) return;
    await this.db.query(`UPDATE lead_ingestion_events SET status='processing', attempts=attempts+1 WHERE id=$1`, [eventId]);
    try {
      if (event.integration_status !== 'active') throw new Error('integration_revoked');
      const lead = this.normalizePayload(event.payload, event.field_mapping ?? {}, Number(event.default_priority ?? 0));
      const result = await this.upsertLead(event, lead);
      await this.db.query(`UPDATE lead_ingestion_events SET status=$2, lead_id=$3, processed_at=now(), error_code=NULL, error_message=NULL WHERE id=$1`, [eventId, result.status, result.leadId]);
      await this.db.query(`UPDATE lead_integrations SET last_success_at=now(), updated_at=now() WHERE id=$1`, [event.integration_id]);
      await this.audit.record({ tenantId: event.tenant_id, action: `lead_ingestion.${result.status}`, entityType: 'lead', entityId: result.leadId, metadata: { eventId, integrationId: event.integration_id } });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      const attempts = Number(event.attempts ?? 0) + 1;
      const terminal = /integ|nome|telefone|pasta|limite|duplic/i.test(message) || attempts >= 5;
      await this.db.query(`UPDATE lead_ingestion_events SET status=$2, error_code=$3, error_message=$4, failed_at=CASE WHEN $2='dead_letter' THEN now() ELSE failed_at END WHERE id=$1`, [eventId, terminal ? 'dead_letter' : 'failed', terminal ? 'processing_failed' : 'temporary_error', message]);
      await this.db.query(`UPDATE lead_integrations SET last_error_at=now(), updated_at=now() WHERE id=$1`, [event.integration_id]);
      if (terminal) await this.audit.record({ tenantId: event.tenant_id, action: 'lead_ingestion.failed', entityType: 'lead_ingestion_event', entityId: eventId, metadata: { error: message } });
      throw error;
    }
  }

  private async upsertLead(event: any, lead: CanonicalLead) {
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${event.tenant_id}`]);
      const existingByExternal = lead.externalId ? await client.query('SELECT id, phone, do_not_call FROM leads WHERE tenant_id=$1 AND source_integration_id=$2 AND external_id=$3 LIMIT 1', [event.tenant_id, event.integration_id, lead.externalId]) : { rows: [] };
      const existingByPhone = await client.query('SELECT id, source_integration_id, external_id, do_not_call FROM leads WHERE tenant_id=$1 AND phone=$2 LIMIT 1', [event.tenant_id, lead.phone]);
      const existing = existingByExternal.rows[0] ?? existingByPhone.rows[0];
      if (existing && event.duplicate_policy === 'reject_duplicate') {
        await client.query(`UPDATE lead_ingestion_events SET status='duplicate', processed_at=now(), lead_id=$2 WHERE id=$1`, [event.id, existing.id]);
        return { status: 'duplicate', leadId: existing.id };
      }
      if (existing && event.duplicate_policy === 'ignore_duplicate') return { status: 'duplicate', leadId: existing.id };
      const folder = await client.query('SELECT id, is_active FROM lead_folders WHERE tenant_id=$1 AND id=$2', [event.tenant_id, event.default_folder_id]);
      if (!folder.rows[0] || !folder.rows[0].is_active) throw new Error('pasta_padrao_inativa');
      if (existing) {
        const updated = await client.query(`UPDATE leads SET name=$1, email=COALESCE($2,email), source_integration_id=COALESCE(source_integration_id,$3), external_id=COALESCE(external_id,$4), queue_priority=$5, last_ingestion_event_id=$6, queued_at=CASE WHEN status IN ('completed','cancelled') THEN now() ELSE queued_at END, status=CASE WHEN status IN ('completed','cancelled') AND do_not_call=false THEN 'queued' ELSE status END, next_eligible_at=CASE WHEN status IN ('completed','cancelled') AND do_not_call=false THEN now() ELSE next_eligible_at END WHERE tenant_id=$7 AND id=$8 RETURNING id`, [lead.name, lead.email ?? null, event.integration_id, lead.externalId ?? null, lead.priority, event.id, event.tenant_id, existing.id]);
        return { status: 'updated', leadId: updated.rows[0].id };
      }
      const quota = await client.query('SELECT t.max_leads, count(l.id)::int AS current FROM tenants t LEFT JOIN leads l ON l.tenant_id=t.id WHERE t.id=$1 GROUP BY t.max_leads', [event.tenant_id]);
      if (Number(quota.rows[0]?.current ?? 0) >= Number(quota.rows[0]?.max_leads ?? 100000)) throw new Error('limite_de_leads_atingido');
      const inserted = await client.query(`INSERT INTO leads (id,tenant_id,folder_id,name,phone,email,source_integration_id,external_id,queue_priority,queued_at,queue_sequence,last_ingestion_event_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),nextval('lead_queue_sequence'),$10) RETURNING id`, [randomUUID(), event.tenant_id, event.default_folder_id, lead.name, lead.phone, lead.email ?? null, event.integration_id, lead.externalId ?? null, lead.priority, event.id]);
      await client.query(`UPDATE leads SET do_not_call=EXISTS (SELECT 1 FROM contact_suppressions s WHERE s.tenant_id=$1 AND s.phone=leads.phone AND s.lifted_at IS NULL) WHERE tenant_id=$1 AND id=$2`, [event.tenant_id, inserted.rows[0].id]);
      return { status: 'accepted', leadId: inserted.rows[0].id };
    });
  }

  async getEvent(tenantId: string, eventId: string) {
    const result = await this.db.query(`SELECT e.id, e.integration_id, e.idempotency_key, e.external_event_id, e.payload_hash, e.status, e.lead_id, e.attempts, e.error_code, e.error_message, e.received_at, e.processed_at, e.failed_at, i.name AS integration_name
      FROM lead_ingestion_events e JOIN lead_integrations i ON i.tenant_id=e.tenant_id AND i.id=e.integration_id WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, eventId]);
    if (!result.rows[0]) throw new NotFoundException('Evento de ingestão não encontrado');
    return result.rows[0];
  }

  async listEvents(tenantId: string, limit = 50, offset = 0) {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const total = await this.db.query('SELECT count(*)::int AS total FROM lead_ingestion_events WHERE tenant_id=$1', [tenantId]);
    const items = await this.db.query(`SELECT e.id, e.integration_id, e.idempotency_key, e.external_event_id, e.status, e.lead_id, e.attempts, e.error_code, e.error_message, e.received_at, e.processed_at, i.name AS integration_name
      FROM lead_ingestion_events e JOIN lead_integrations i ON i.tenant_id=e.tenant_id AND i.id=e.integration_id WHERE e.tenant_id=$1 ORDER BY e.received_at DESC LIMIT $2 OFFSET $3`, [tenantId, safeLimit, safeOffset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }
}
