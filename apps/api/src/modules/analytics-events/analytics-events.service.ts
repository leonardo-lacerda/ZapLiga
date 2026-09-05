import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { AckPolicy, connect, DeliverPolicy, JetStreamClient, JetStreamManager, NatsConnection, StringCodec } from 'nats';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import { ANALYTICS_EVENT_SCHEMA_VERSION, analyticsCatalog, AnalyticsEventType, sanitizeAnalyticsPayload } from './analytics-events.catalog';
import { calculateAnalyticsReliability, ANALYTICS_RELIABILITY_FORMULA_VERSION } from './analytics-reliability';

const SUBJECT = 'zapliga.analytics.events';
const STREAM = 'ZAPLIGA_ANALYTICS_EVENTS';
const CONSUMER = 'analytics-event-worker';
const EVENT_TYPES = Object.keys(analyticsCatalog().reduce<Record<string, boolean>>((result, item) => ({ ...result, [item.eventType]: true }), {}));
type Executor = { query: (text: string, params?: unknown[]) => Promise<any> };

export type AnalyticsEventInput = {
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  campaignId?: string | null;
  campaignVersion?: number | null;
  correlationId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date | string;
};

@Injectable()
export class AnalyticsEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsEventsService.name);
  private readonly codec = StringCodec();
  private nats?: NatsConnection;
  private jetstream?: JetStreamClient;
  private manager?: JetStreamManager;
  private publisherTimer?: NodeJS.Timeout;
  private consumerRunning = false;

  constructor(private readonly db: DatabaseService, @Optional() private readonly webhooks?: OutboundWebhooksService) {}

  onModuleInit() {
    this.publisherTimer = setInterval(() => void this.flushOutbox(), 1000);
    this.publisherTimer.unref?.();
    void this.flushOutbox();
  }

  async onModuleDestroy() {
    if (this.publisherTimer) clearInterval(this.publisherTimer);
    await this.nats?.drain().catch(() => undefined);
  }

  private async natsReady() {
    if (!this.nats) {
      this.nats = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222', name: 'zapliga-analytics-events' });
      this.jetstream = this.nats.jetstream();
      this.manager = await this.nats.jetstreamManager();
      try { await this.manager.streams.add({ name: STREAM, subjects: [SUBJECT], retention: 'limits' as any, storage: 'file' as any, max_msgs: -1 }); } catch { /* stream already exists */ }
      try {
        await this.manager.consumers.add(STREAM, { durable_name: CONSUMER, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: SUBJECT, max_deliver: 5, ack_wait: 60_000_000_000 });
      } catch { /* consumer already exists */ }
    }
    return { jetstream: this.jetstream!, manager: this.manager! };
  }

  private async recordInExecutor(input: AnalyticsEventInput, executor: Executor) {
    const eventType = String(input.eventType) as AnalyticsEventType;
    const payload = sanitizeAnalyticsPayload(eventType, input.payload ?? {});
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (!Number.isFinite(occurredAt.getTime())) throw new BadRequestException('Timestamp do evento analítico inválido');
    const inserted = await executor.query(`INSERT INTO analytics_events
      (id, tenant_id, event_type, schema_version, aggregate_type, aggregate_id, campaign_id, campaign_version, correlation_id, idempotency_key, payload, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, [
      randomUUID(), input.tenantId, eventType, ANALYTICS_EVENT_SCHEMA_VERSION, input.aggregateType, input.aggregateId,
      input.campaignId ?? null, input.campaignVersion ?? null, input.correlationId ?? null, input.idempotencyKey,
      JSON.stringify(payload), occurredAt.toISOString(),
    ]);
    const eventId = inserted.rows[0]?.id ?? (await executor.query('SELECT id FROM analytics_events WHERE tenant_id=$1 AND idempotency_key=$2', [input.tenantId, input.idempotencyKey])).rows[0]?.id;
    if (!eventId) throw new Error('Não foi possível obter o evento analítico idempotente');
    await executor.query(`INSERT INTO analytics_event_outbox (id, tenant_id, event_id, subject, payload)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (event_id) DO NOTHING`, [randomUUID(), input.tenantId, eventId, SUBJECT, JSON.stringify({ eventId })]);
    return { eventId, eventType, schemaVersion: ANALYTICS_EVENT_SCHEMA_VERSION };
  }

  async record(input: AnalyticsEventInput, executor: Executor = this.db) {
    if (executor === this.db) return this.db.transaction((client) => this.recordInExecutor(input, client));
    return this.recordInExecutor(input, executor);
  }

  async catalog() { return { formulaVersion: ANALYTICS_RELIABILITY_FORMULA_VERSION, items: analyticsCatalog() }; }

  async listEvents(tenantId: string, limit = 50, offset = 0) {
    const safeLimit = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const total = await this.db.query('SELECT count(*)::int AS total FROM analytics_events WHERE tenant_id=$1', [tenantId]);
    const items = await this.db.query(`SELECT id, event_type, schema_version, aggregate_type, aggregate_id, campaign_id, campaign_version, correlation_id, idempotency_key, payload, occurred_at, recorded_at
      FROM analytics_events WHERE tenant_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`, [tenantId, safeLimit, safeOffset]);
    return { items: items.rows, total: Number(total.rows[0]?.total ?? 0), limit: safeLimit, offset: safeOffset };
  }

  private period(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new BadRequestException('Período analítico inválido');
    if (end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) throw new BadRequestException('O período máximo de reconciliação é de 366 dias');
    return { start, end };
  }

  async reconcile(tenantId: string, from?: string, to?: string) {
    const { start, end } = this.period(from, to);
    const [source, events, quality, order, rollup, pending, delay] = await Promise.all([
      this.db.query('SELECT count(*)::int AS count FROM calls WHERE tenant_id=$1 AND created_at >= $2 AND created_at < $3', [tenantId, start.toISOString(), end.toISOString()]),
      this.db.query('SELECT count(*)::int AS count FROM analytics_events WHERE tenant_id=$1 AND event_type=\'call.ended\' AND occurred_at >= $2 AND occurred_at < $3', [tenantId, start.toISOString(), end.toISOString()]),
      this.db.query(`SELECT
        count(*) FILTER (WHERE event_type <> ALL($4::text[]))::int AS invalid,
        count(*) FILTER (WHERE occurred_at > now() + interval '5 minutes')::int AS future
        FROM analytics_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3`, [tenantId, start.toISOString(), end.toISOString(), EVENT_TYPES]),
      this.db.query(`WITH ordered AS (
        SELECT occurred_at, lag(occurred_at) OVER (PARTITION BY aggregate_type, aggregate_id ORDER BY recorded_at, id) AS previous_at
        FROM analytics_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3
      ) SELECT count(*) FILTER (WHERE previous_at IS NOT NULL AND occurred_at < previous_at)::int AS count FROM ordered`, [tenantId, start.toISOString(), end.toISOString()]),
      this.db.query(`WITH source AS (
          SELECT (c.created_at AT TIME ZONE COALESCE(t.timezone, 'America/Sao_Paulo'))::date AS day, count(*)::int AS calls
          FROM calls c JOIN tenants t ON t.id=c.tenant_id
          WHERE c.tenant_id=$1 AND c.created_at >= $2 AND c.created_at < $3 GROUP BY 1
        ), rollup AS (
          SELECT day, calls_made AS calls FROM metrics_daily_rollup WHERE tenant_id=$1
            AND day >= ($2 AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id=$1), 'America/Sao_Paulo'))::date
            AND day <= ($3 AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id=$1), 'America/Sao_Paulo'))::date
        ) SELECT COALESCE(sum(abs(COALESCE(source.calls,0)-COALESCE(rollup.calls,0))),0)::int AS count
        FROM source FULL OUTER JOIN rollup USING (day)`, [tenantId, start.toISOString(), end.toISOString()]),
      this.db.query(`SELECT count(*)::int AS count FROM analytics_event_outbox WHERE tenant_id=$1 AND status='pending'`, [tenantId]),
      this.db.query(`SELECT avg(EXTRACT(EPOCH FROM (published_at - created_at)))::numeric AS seconds
        FROM analytics_event_outbox
        WHERE tenant_id=$1 AND status='published' AND created_at >= $2 AND created_at < $3`, [tenantId, start.toISOString(), end.toISOString()]),
    ]);
    const sourceCalls = Number(source.rows[0]?.count ?? 0);
    const eventCalls = Number(events.rows[0]?.count ?? 0);
    const duplicateEvents = 0;
    const invalidEvents = Number(quality.rows[0]?.invalid ?? 0);
    const futureEvents = Number(quality.rows[0]?.future ?? 0);
    const outOfOrderEvents = Number(order.rows[0]?.count ?? 0);
    const rollupDivergences = Number(rollup.rows[0]?.count ?? 0);
    const pendingOutbox = Number(pending.rows[0]?.count ?? 0);
    const outboxDelaySeconds = delay.rows[0]?.seconds == null ? null : Number(delay.rows[0].seconds);
    const reliability = calculateAnalyticsReliability({ sourceCalls, eventCalls, duplicateEvents, invalidEvents, futureEvents, outOfOrderEvents, rollupDivergences, pendingOutbox });
    const details = { coverage: sourceCalls ? eventCalls / sourceCalls : null, outboxDelaySeconds, source: 'calls', event: 'analytics_events', eventTypes: EVENT_TYPES };
    const row = (await this.db.query(`INSERT INTO analytics_reconciliation_runs
      (id, tenant_id, period_start, period_end, source_calls, event_calls, missing_events, duplicate_events, invalid_events, future_events, out_of_order_events, rollup_divergences, pending_outbox, outbox_delay_seconds, reliability_score, reliability_status, formula_version, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) RETURNING *`, [
      randomUUID(), tenantId, start.toISOString(), end.toISOString(), sourceCalls, eventCalls, reliability.missingEvents,
      duplicateEvents, invalidEvents, futureEvents, outOfOrderEvents, rollupDivergences, pendingOutbox, outboxDelaySeconds, reliability.score,
      reliability.status, reliability.formulaVersion, JSON.stringify(details),
    ])).rows[0];
    return this.mapReliability(row);
  }

  private mapReliability(row: any) {
    return {
      id: row.id, periodStart: row.period_start, periodEnd: row.period_end,
      sourceCalls: Number(row.source_calls), eventCalls: Number(row.event_calls), missingEvents: Number(row.missing_events),
      duplicateEvents: Number(row.duplicate_events), invalidEvents: Number(row.invalid_events), futureEvents: Number(row.future_events),
      outOfOrderEvents: Number(row.out_of_order_events), rollupDivergences: Number(row.rollup_divergences), pendingOutbox: Number(row.pending_outbox), outboxDelaySeconds: row.outbox_delay_seconds == null ? null : Number(row.outbox_delay_seconds),
      score: Number(row.reliability_score), status: row.reliability_status, formulaVersion: Number(row.formula_version), details: row.details ?? {}, computedAt: row.computed_at,
    };
  }

  async reliability(tenantId: string) {
    const row = (await this.db.query('SELECT * FROM analytics_reconciliation_runs WHERE tenant_id=$1 ORDER BY computed_at DESC LIMIT 1', [tenantId])).rows[0];
    return row ? this.mapReliability(row) : { score: 0, status: 'insufficient_data', formulaVersion: ANALYTICS_RELIABILITY_FORMULA_VERSION, message: 'Execute uma reconciliação para formar o primeiro indicador.' };
  }

  async outboxHealth(tenantId: string) {
    const result = await this.db.query(`SELECT status, count(*)::int AS count FROM analytics_event_outbox WHERE tenant_id=$1 GROUP BY status`, [tenantId]);
    return { items: result.rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.status]: Number(row.count) }), {}) };
  }

  private async flushOutbox() {
    try {
      const { jetstream } = await this.natsReady();
      const rows = (await this.db.query(`SELECT id, event_id, subject, payload FROM analytics_event_outbox
        WHERE status='pending' AND next_attempt_at <= now() ORDER BY created_at LIMIT 50`)).rows;
      for (const row of rows) {
        try {
          await jetstream.publish(row.subject, this.codec.encode(JSON.stringify(row.payload)), { msgID: row.event_id });
          await this.db.query(`UPDATE analytics_event_outbox SET status='published', published_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1 AND status='pending'`, [row.id]);
        } catch (error) {
          await this.db.query(`UPDATE analytics_event_outbox SET attempts=attempts+1, next_attempt_at=now() + (LEAST(300, GREATEST(5, attempts * 5)) * interval '1 second'), last_error=$2, status=CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id=$1`, [row.id, String(error).slice(0, 300)]).catch(() => undefined);
        }
      }
      await this.consume();
    } catch { /* a missing NATS connection leaves the durable outbox for retry */ }
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
          const event = (await this.db.query('SELECT id, tenant_id, event_type, schema_version, payload, occurred_at FROM analytics_events WHERE id=$1', [parsed.eventId])).rows[0];
          if (event) {
            await this.webhooks?.enqueueForEvent({ eventId: event.id, tenantId: event.tenant_id, eventType: event.event_type, schemaVersion: Number(event.schema_version), payload: event.payload ?? {}, occurredAt: new Date(event.occurred_at).toISOString() });
            await this.db.query(`INSERT INTO analytics_event_receipts (event_id, tenant_id) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING`, [event.id, event.tenant_id]);
          }
          message.ack();
        } catch (error) {
          this.logger.warn(`Falha ao consumir evento analítico: ${String(error).slice(0, 240)}`);
          message.nak(5000);
        }
      }
      await messages.close();
    } catch { /* consumer is retried by the next outbox tick */ }
    finally { this.consumerRunning = false; }
  }
}
