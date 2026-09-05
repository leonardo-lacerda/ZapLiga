import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ANALYTICS_EVENT_CATALOG, AnalyticsEventType } from '../analytics-events/analytics-events.catalog';
import { decryptSecret, encryptSecret, webhookSignature } from '../lead-ingestion/lead-ingestion.crypto';

const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10_000;

type WebhookExecutor = { query: (text: string, params?: unknown[]) => Promise<any> };

const isLocalHost = (hostname: string) => ['localhost', '127.0.0.1', '::1'].includes(hostname);

@Injectable()
export class OutboundWebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundWebhooksService.name);
  private deliveryTimer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.deliveryTimer = setInterval(() => void this.flush(), 1000);
    this.deliveryTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
  }

  private assertUrl(value: string) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new BadRequestException('Informe uma URL válida para o webhook'); }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) {
      throw new BadRequestException('Webhooks outbound exigem HTTPS; HTTP é permitido somente para hosts locais de teste');
    }
    return parsed.toString();
  }

  private eventTypes(input?: string[]) {
    const values = [...new Set((input ?? []).map((item) => String(item).trim()).filter(Boolean))];
    if (!values.length || values.includes('*')) return ['*'];
    const unknown = values.filter((item) => !(item in ANALYTICS_EVENT_CATALOG));
    if (unknown.length) throw new BadRequestException(`Eventos não catalogados: ${unknown.join(', ')}`);
    return values;
  }

  private publicEndpoint(row: any) {
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      eventTypes: row.event_types ?? ['*'],
      status: row.status,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }

  async list(tenantId: string) {
    const rows = await this.db.query('SELECT * FROM outbound_webhook_endpoints WHERE tenant_id=$1 ORDER BY created_at DESC', [tenantId]);
    return { items: rows.rows.map((row) => this.publicEndpoint(row)) };
  }

  async create(tenantId: string, userId: string, input: { label: string; url: string; eventTypes?: string[] }) {
    const label = String(input.label ?? '').trim();
    if (label.length < 2 || label.length > 80) throw new BadRequestException('O nome do webhook deve ter entre 2 e 80 caracteres');
    const url = this.assertUrl(String(input.url ?? '').trim());
    const eventTypes = this.eventTypes(input.eventTypes);
    const secret = `zpl_wh_${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query(`INSERT INTO outbound_webhook_endpoints
      (id, tenant_id, label, url, event_types, secret_ciphertext, created_by)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`, [randomUUID(), tenantId, label, url, JSON.stringify(eventTypes), encryptSecret(secret), userId])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'outbound_webhook.created', entityType: 'outbound_webhook', entityId: row.id, metadata: { eventTypes } });
    return { ...this.publicEndpoint(row), secret };
  }

  async rotate(tenantId: string, userId: string, id: string) {
    const current = (await this.db.query('SELECT * FROM outbound_webhook_endpoints WHERE tenant_id=$1 AND id=$2', [tenantId, id])).rows[0];
    if (!current) throw new NotFoundException('Webhook não encontrado');
    if (current.status !== 'active') throw new BadRequestException('O webhook está revogado');
    const secret = `zpl_wh_${randomBytes(30).toString('base64url')}`;
    const row = (await this.db.query('UPDATE outbound_webhook_endpoints SET secret_ciphertext=$1, updated_at=now() WHERE tenant_id=$2 AND id=$3 RETURNING *', [encryptSecret(secret), tenantId, id])).rows[0];
    await this.audit.record({ actorUserId: userId, tenantId, action: 'outbound_webhook.rotated', entityType: 'outbound_webhook', entityId: id });
    return { ...this.publicEndpoint(row), secret };
  }

  async revoke(tenantId: string, userId: string, id: string) {
    const row = (await this.db.query(`UPDATE outbound_webhook_endpoints SET status='revoked', revoked_at=COALESCE(revoked_at,now()), updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, id])).rows[0];
    if (!row) throw new NotFoundException('Webhook não encontrado');
    await this.audit.record({ actorUserId: userId, tenantId, action: 'outbound_webhook.revoked', entityType: 'outbound_webhook', entityId: id });
    return this.publicEndpoint(row);
  }

  async listDeliveries(tenantId: string, endpointId: string, limit = 50) {
    const endpoint = await this.db.query('SELECT id FROM outbound_webhook_endpoints WHERE tenant_id=$1 AND id=$2', [tenantId, endpointId]);
    if (!endpoint.rows[0]) throw new NotFoundException('Webhook não encontrado');
    const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    const rows = await this.db.query(`SELECT id, event_id, event_type, status, attempts, next_attempt_at, delivered_at, last_status_code, last_error, created_at, updated_at
      FROM outbound_webhook_deliveries WHERE tenant_id=$1 AND endpoint_id=$2 ORDER BY created_at DESC LIMIT $3`, [tenantId, endpointId, safeLimit]);
    return { items: rows.rows };
  }

  async enqueueForEvent(input: { eventId: string; tenantId: string; eventType: AnalyticsEventType; payload: Record<string, unknown>; occurredAt: string; schemaVersion: number }) {
    const endpoints = await this.db.query(`SELECT id FROM outbound_webhook_endpoints
      WHERE tenant_id=$1 AND status='active' AND (event_types ? '*' OR event_types ? $2)`, [input.tenantId, input.eventType]);
    for (const endpoint of endpoints.rows) {
      const envelope = { id: input.eventId, type: input.eventType, schemaVersion: input.schemaVersion, occurredAt: input.occurredAt, tenantId: input.tenantId, payload: input.payload };
      await this.db.query(`INSERT INTO outbound_webhook_deliveries
        (id, tenant_id, endpoint_id, event_id, idempotency_key, event_type, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (tenant_id, endpoint_id, event_id) DO NOTHING`, [randomUUID(), input.tenantId, endpoint.id, input.eventId, `webhook:${endpoint.id}:${input.eventId}`, input.eventType, JSON.stringify(envelope)]);
    }
  }

  private async deliver(row: any) {
    const endpoint = (await this.db.query('SELECT url, secret_ciphertext FROM outbound_webhook_endpoints WHERE tenant_id=$1 AND id=$2 AND status=\'active\'', [row.tenant_id, row.endpoint_id])).rows[0];
    if (!endpoint) return;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(row.payload ?? {});
    const signature = webhookSignature(decryptSecret(endpoint.secret_ciphertext), timestamp, Buffer.from(body));
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ZapLiga-Webhooks/1',
        'x-zapliga-event-id': row.event_id,
        'x-zapliga-event-type': row.event_type,
        'x-zapliga-timestamp': timestamp,
        'x-zapliga-signature': `sha256=${signature}`,
        'idempotency-key': row.idempotency_key,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.status;
  }

  async flush() {
    const rows = (await this.db.query(`SELECT id, tenant_id, endpoint_id, event_id, event_type, idempotency_key, payload, attempts
      FROM outbound_webhook_deliveries WHERE status='pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT 20`)).rows;
    for (const row of rows) {
      const attempt = Number(row.attempts ?? 0) + 1;
      try {
        const statusCode = await this.deliver(row);
        await this.db.query(`UPDATE outbound_webhook_deliveries SET status='delivered', attempts=$2, delivered_at=now(), last_status_code=$3, last_error=NULL, updated_at=now()
          WHERE tenant_id=$1 AND id=$4 AND status='pending'`, [row.tenant_id, attempt, statusCode ?? 200, row.id]);
        await this.db.query('UPDATE outbound_webhook_endpoints SET last_success_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.endpoint_id]);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 300);
        const nextDelaySeconds = Math.min(3600, 2 ** Math.min(attempt, 10));
        await this.db.query(`UPDATE outbound_webhook_deliveries SET status=CASE WHEN $2 >= $3 THEN 'dead_letter' ELSE 'pending' END,
          attempts=$2, next_attempt_at=now() + ($4::int * interval '1 second'), last_error=$5, updated_at=now()
          WHERE tenant_id=$1 AND id=$6 AND status='pending'`, [row.tenant_id, attempt, MAX_ATTEMPTS, nextDelaySeconds, message, row.id]);
        await this.db.query('UPDATE outbound_webhook_endpoints SET last_failure_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.endpoint_id]).catch(() => undefined);
        this.logger.warn(`Falha na entrega outbound ${row.id}: ${message}`);
      }
    }
  }
}
