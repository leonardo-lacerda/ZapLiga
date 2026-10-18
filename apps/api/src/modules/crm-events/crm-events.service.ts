import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { decryptSecret, webhookSignature } from '../lead-ingestion/lead-ingestion.crypto';
import { CALL_SELECT, LINE_SELECT, callView, lineView } from './crm-events.views';

export const CRM_EVENT_SCHEMA_VERSION = 1;
export type CrmCallEventType = 'call.reserved' | 'call.dialing' | 'call.answered' | 'call.ended' | 'call.wrap_up_completed';
export type CrmLineEventType = 'number.created' | 'number.updated' | 'number.status_changed' | 'number.removed';

const MAX_ATTEMPTS = 10;
const DELIVERY_TIMEOUT_MS = 10_000;
const CLAIM_LEASE_SECONDS = 30;
const BATCH_SIZE = 20;
const RETENTION_DAYS = 30;

type Executor = { query: (text: string, params?: unknown[]) => Promise<any> };

/** Backoff between attempts: 2s, 4s, 8s ... capped at 15 min (about 1h until dead-letter). */
export const nextDelaySeconds = (attempt: number) => Math.min(900, 2 ** Math.min(attempt, 10));

/**
 * Outbox of events for CRM integrations. Recording is best-effort and never blocks the call path:
 * callers fire and forget. Delivery runs on every API instance; claims are leased atomically so an
 * event is posted by one instance at a time. Order is not guaranteed across retries -- every event
 * carries the full current call or line, and the CRM keeps the newest `occurredAt`.
 */
@Injectable()
export class CrmEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CrmEventsService.name);
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private lastPurgeAt = 0;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.CRM_EVENTS_DELIVERY === 'off') return;
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async insert(executor: Executor, input: { tenantId: string; integrationId: string; eventType: string; idempotencyKey: string; payload: Record<string, unknown> }) {
    const id = randomUUID();
    const envelope = { id, type: input.eventType, schemaVersion: CRM_EVENT_SCHEMA_VERSION, occurredAt: new Date().toISOString(), tenantId: input.tenantId, integrationId: input.integrationId, payload: input.payload };
    await executor.query(`INSERT INTO crm_integration_events (id, tenant_id, integration_id, event_type, idempotency_key, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (integration_id, idempotency_key) DO NOTHING`,
    [id, input.tenantId, input.integrationId, input.eventType, input.idempotencyKey, JSON.stringify(envelope)]);
  }

  /** Records a call event when the call was placed by an integration that has a webhook. */
  async recordCall(tenantId: string, callId: string, eventType: CrmCallEventType, extra: Record<string, unknown> = {}) {
    const result = await this.db.query(`${CALL_SELECT}
      JOIN crm_integrations i ON i.id = c.integration_id AND i.status = 'active' AND i.webhook_url IS NOT NULL
      WHERE c.tenant_id = $1 AND c.id = $2 LIMIT 1`, [tenantId, callId]);
    const row = result.rows[0];
    if (!row) return;
    await this.insert(this.db, { tenantId, integrationId: row.integration_id, eventType, idempotencyKey: `${eventType}:${callId}`, payload: { call: callView(row), ...extra } });
  }

  /** Records a line event for every connected integration of the tenant. */
  async recordLine(tenantId: string, numberId: string, eventType: CrmLineEventType) {
    const integrations = await this.db.query(`SELECT id FROM crm_integrations WHERE tenant_id = $1 AND status = 'active' AND webhook_url IS NOT NULL`, [tenantId]);
    if (!integrations.rows.length) return;
    const line = (await this.db.query(`${LINE_SELECT} WHERE n.tenant_id = $1 AND n.id = $2 LIMIT 1`, [tenantId, numberId])).rows[0];
    if (!line) return;
    // Line events repeat (connected -> disconnected -> connected), so each one is its own key.
    const key = `${eventType}:${numberId}:${randomUUID()}`;
    for (const integration of integrations.rows) await this.insert(this.db, { tenantId, integrationId: integration.id, eventType, idempotencyKey: key, payload: { number: lineView(line) } });
  }

  /** A test event the CRM can trigger to check its receiver end to end. */
  async recordPing(tenantId: string, integrationId: string) {
    await this.insert(this.db, { tenantId, integrationId, eventType: 'integration.ping', idempotencyKey: `integration.ping:${randomUUID()}`, payload: { message: 'ZapLiga webhook test' } });
  }

  async list(tenantId: string, integrationId: string, filters: { status?: string; limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, Math.floor(Number(filters.limit) || 50)));
    const params: unknown[] = [tenantId, integrationId];
    let clause = '';
    if (filters.status && ['pending', 'delivered', 'dead_letter'].includes(filters.status)) { params.push(filters.status); clause = ` AND status = $${params.length}`; }
    params.push(limit);
    const result = await this.db.query(`SELECT id, event_type, status, attempts, next_attempt_at, delivered_at, last_status_code, last_error, created_at
      FROM crm_integration_events WHERE tenant_id = $1 AND integration_id = $2${clause} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return { items: result.rows };
  }

  /** Puts a failed (or delivered) event back in the queue for one more round of attempts. */
  async retry(tenantId: string, integrationId: string, eventId: string) {
    const result = await this.db.query(`UPDATE crm_integration_events SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_until = NULL, updated_at = now()
      WHERE tenant_id = $1 AND integration_id = $2 AND id = $3 RETURNING id, status`, [tenantId, integrationId, eventId]);
    if (!result.rows[0]) throw new NotFoundException('Evento não encontrado');
    return result.rows[0];
  }

  private async claim() {
    const result = await this.db.query(`UPDATE crm_integration_events SET locked_until = now() + ($1::int * interval '1 second')
      WHERE id IN (
        SELECT id FROM crm_integration_events
        WHERE status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now())
        ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
      ) RETURNING id, tenant_id, integration_id, event_type, idempotency_key, payload, attempts`, [CLAIM_LEASE_SECONDS, BATCH_SIZE]);
    return result.rows;
  }

  private async deliver(row: any) {
    const integration = (await this.db.query(`SELECT webhook_url, webhook_secret_ciphertext FROM crm_integrations WHERE id = $1 AND status = 'active'`, [row.integration_id])).rows[0];
    if (!integration?.webhook_url || !integration.webhook_secret_ciphertext) throw new Error('Integração sem webhook ativo');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(row.payload ?? {});
    const signature = webhookSignature(decryptSecret(integration.webhook_secret_ciphertext), timestamp, Buffer.from(body));
    const response = await fetch(integration.webhook_url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ZapLiga-CRM-Webhooks/1',
        'x-zapliga-event-id': row.id,
        'x-zapliga-event-type': row.event_type,
        'x-zapliga-timestamp': timestamp,
        'x-zapliga-signature': `sha256=${signature}`,
        'idempotency-key': row.idempotency_key,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status });
    return response.status;
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const rows = await this.claim();
      for (const row of rows) {
        const attempt = Number(row.attempts ?? 0) + 1;
        try {
          const statusCode = await this.deliver(row);
          await this.db.query(`UPDATE crm_integration_events SET status = 'delivered', attempts = $2, delivered_at = now(), last_status_code = $3, last_error = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`, [row.id, attempt, statusCode]);
          await this.db.query('UPDATE crm_integrations SET last_delivery_at = now() WHERE id = $1', [row.integration_id]);
        } catch (error) {
          const message = String(error instanceof Error ? error.message : error).slice(0, 300);
          const statusCode = (error as { statusCode?: number }).statusCode ?? null;
          this.logger.warn(`CRM event ${row.id} (${row.event_type}) delivery failed: ${message}`);
          // Explicit casts: an untyped parameter compared in CASE is inferred as text by Postgres.
          // One bad row must not abort the batch; its lease simply expires and it is retried.
          await this.db.query(`UPDATE crm_integration_events SET status = CASE WHEN $2::int >= $3::int THEN 'dead_letter' ELSE 'pending' END, attempts = $2::int,
            next_attempt_at = now() + ($4::int * interval '1 second'), last_status_code = $5::int, last_error = $6, locked_until = NULL, updated_at = now() WHERE id = $1`,
          [row.id, attempt, MAX_ATTEMPTS, nextDelaySeconds(attempt), statusCode, message]).catch((updateError) => this.logger.warn(`CRM event ${row.id} retry not scheduled: ${String((updateError as Error)?.message ?? updateError).slice(0, 200)}`));
          await this.db.query('UPDATE crm_integrations SET last_delivery_failure_at = now() WHERE id = $1', [row.integration_id]).catch(() => undefined);
        }
      }
      if (Date.now() - this.lastPurgeAt > 3_600_000) {
        this.lastPurgeAt = Date.now();
        await this.db.query(`DELETE FROM crm_integration_events WHERE status = 'delivered' AND delivered_at < now() - ($1::int * interval '1 day')`, [RETENTION_DAYS]);
      }
    } catch (error) {
      this.logger.warn(`CRM event flush failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    } finally {
      this.flushing = false;
    }
  }
}
