import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { CrmEventsService } from '../crm-events/crm-events.service';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { LINE_RETIRED_AFTER_LOSSES } from './dialer.rules';
import { LINE_LOSS_EVENT_TYPES, LINE_OUT_CAUSES, LineLossSignal, REACHOUT_TIMELOCK_NACK, classifyLineLoss, dialBlockUntil, lineLossEventId, lineLossPolicyEnabled, reachoutTimelockEnd } from './line-loss.rules';

interface LineRow {
  id: string;
  tenant_id: string;
  label: string;
  waxum_session_id?: string | null;
  removal_count?: number;
}

/** Causes the policy writes into number_health_events (migration 082). */
const HEALTH_EVENT_CAUSES: ReadonlySet<string> = new Set(['temp_banned', 'reachout_timelock', 'media_failure']);

/**
 * Records why WhatsApp took a line away or held it back (line-loss.rules), one row per signal in
 * `line_loss_events` (migration 082), and marks a line WhatsApp removed or locked: it leaves the
 * dialer and the egress pool, the operators see why, and a line lost LINE_RETIRED_AFTER_LOSSES
 * times is retired (no new QR). Both API instances get each event; one stores it, both tell their
 * own dashboards.
 */
@Injectable()
export class LineLossService implements OnModuleInit {
  private readonly logger = new Logger(LineLossService.name);

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient, private readonly audit: AuditService, private readonly gateway: SdrGateway, @Optional() private readonly crmEvents?: CrmEventsService) {}

  onModuleInit() {
    void this.waxum.subscribeSessionEvents([...LINE_LOSS_EVENT_TYPES], (sessionId, type, payload) => this.handle(sessionId, type, payload))
      .catch((error) => this.logger.error(`Line loss events not subscribed: ${String((error as Error)?.message ?? error).slice(0, 300)}`));
  }

  async handle(sessionId: string, type: string, payload: unknown) {
    const lossSignal = classifyLineLoss(type, payload);
    if (!lossSignal) return;
    if (LINE_OUT_CAUSES.has(lossSignal.cause)) {
      await this.markLost(sessionId, type, payload, lossSignal);
      return;
    }
    const line = (await this.db.query<LineRow>(`SELECT id, tenant_id, label, waxum_session_id FROM whatsapp_numbers WHERE waxum_session_id = $1 AND status <> 'removed' LIMIT 1`, [sessionId])).rows[0];
    if (!line) return;
    if (!(await this.record(line, sessionId, type, payload, lossSignal))) return;
    this.logger.log(`Line ${line.id} (${line.label}): ${lossSignal.cause}${lossSignal.code ? ` (${lossSignal.code})` : ''}`);
    if (lossSignal.cause === 'client_rejected') this.logger.error(`WhatsApp refused the client of line ${line.id} (${line.label}): ${lossSignal.code ?? 'sem código'}. Check the Waxum version.`);
    await this.applyPolicy(line, lossSignal);
  }

  policyEnabled(tenantId: string) {
    return lineLossPolicyEnabled(tenantId);
  }

  /**
   * What a cause asks of the dialer, with LINE_LOSS_POLICY=v2 (docs/line-loss-causes.md): the line
   * does not dial until the deadline the server stated (a ban's expire, a timelock's end, read from
   * the server) or a fallback. Returns the deadline written, or null.
   */
  async applyPolicy(line: LineRow, lossSignal: LineLossSignal): Promise<Date | null> {
    if (!this.policyEnabled(line.tenant_id)) return null;
    let statedEnd = lossSignal.expiresAt;
    if (lossSignal.cause === 'reachout_timelock' && line.waxum_session_id) {
      statedEnd = reachoutTimelockEnd(await this.waxum.getReachoutTimelock(line.waxum_session_id).catch(() => null)) ?? statedEnd;
    }
    const until = dialBlockUntil(lossSignal.cause, statedEnd);
    if (!until) return null;
    await this.db.query(`
      UPDATE whatsapp_numbers SET dial_blocked_until = GREATEST(COALESCE(dial_blocked_until, now()), $3), dial_block_cause = $4
      WHERE id = $1 AND tenant_id = $2
    `, [line.id, line.tenant_id, until, lossSignal.cause]);
    if (HEALTH_EVENT_CAUSES.has(lossSignal.cause)) {
      const metadata = { cause: lossSignal.cause, code: lossSignal.code, until: until.toISOString(), statedByServer: Boolean(statedEnd) };
      await this.db.query(`
        INSERT INTO number_health_events (tenant_id, number_id, event_type, actor_type, metadata, occurred_at)
        VALUES ($1, $2, $3, 'automatic', $4::jsonb, now())
      `, [line.tenant_id, line.id, lossSignal.cause, JSON.stringify(metadata)]);
    }
    this.logger.warn(`Line ${line.id} (${line.label}) does not dial until ${until.toISOString()}: ${lossSignal.cause}`);
    this.gateway.broadcastToOperations({ type: 'operations_changed', reason: 'number_dial_blocked', at: new Date().toISOString(), activity: { kind: 'number_dial_blocked', numberId: line.id, label: line.label, cause: lossSignal.cause, until: until.toISOString() } }, line.tenant_id);
    void this.crmEvents?.recordLine(line.tenant_id, line.id, 'number.status_changed').catch(() => undefined);
    return until;
  }

  /**
   * A call that opened and died without audio (the dialer's "instant failure"). With a 463 for the
   * call the server stated a reachout timelock, which holds the line at once; without one it is a
   * media failure, and the line pauses briefly once the dialer's streak reaches its threshold.
   */
  async onInstantFailure(numberId: string, tenantId: string, callId: string, thresholdReached: boolean): Promise<Date | null> {
    const line = (await this.db.query<LineRow & { dial_block_cause: string | null; dial_blocked_until: Date | null }>(
      'SELECT id, tenant_id, label, waxum_session_id, dial_block_cause, dial_blocked_until FROM whatsapp_numbers WHERE id = $1 AND tenant_id = $2',
      [numberId, tenantId],
    )).rows[0];
    if (!line) return null;
    const nack = (await this.db.query(
      `SELECT 1 FROM call_signal_events WHERE tenant_id = $1 AND call_id = $2 AND kind = 'call_ack' AND detail->>'error' = $3 LIMIT 1`,
      [tenantId, callId, REACHOUT_TIMELOCK_NACK],
    )).rows[0];
    if (nack && line.dial_block_cause === 'reachout_timelock' && line.dial_blocked_until && new Date(line.dial_blocked_until).getTime() > Date.now()) {
      return new Date(line.dial_blocked_until);
    }
    if (!nack && !thresholdReached) return null;
    const cause = nack ? 'reachout_timelock' : 'media_failure';
    const lossSignal: LineLossSignal = { cause, sourceEvent: 'instant_failure', code: nack ? REACHOUT_TIMELOCK_NACK : null, violationType: null, violationReason: null, expiresAt: null, detail: { callId } };
    await this.record(line, line.waxum_session_id ?? null, `instant_failure:${callId}`, {}, lossSignal);
    return this.applyPolicy(line, lossSignal);
  }

  /** Stores the signal once across both API instances; true for the instance that stored it. */
  async record(line: Pick<LineRow, 'id' | 'tenant_id'>, sessionId: string | null, type: string, payload: unknown, lossSignal: LineLossSignal): Promise<boolean> {
    const id = lineLossEventId(sessionId ?? line.id, type, payload, lossSignal.code);
    const inserted = await this.db.query<{ id: string }>(`
      INSERT INTO line_loss_events (id, tenant_id, number_id, waxum_session_id, cause, source_event, code, violation_type, violation_reason, expires_at, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `, [id, line.tenant_id, line.id, sessionId, lossSignal.cause, lossSignal.sourceEvent, lossSignal.code, lossSignal.violationType, lossSignal.violationReason, lossSignal.expiresAt, JSON.stringify(lossSignal.detail)]);
    return Boolean(inserted.rows[0]);
  }

  private async markLost(sessionId: string, type: string, payload: unknown, lossSignal: LineLossSignal) {
    const reason = lossSignal.cause;
    const lossDetail = { code: lossSignal.code, violationType: lossSignal.violationType, violationReason: lossSignal.violationReason };
    const updated = (await this.db.query<LineRow>(`
      UPDATE whatsapp_numbers SET loss_reason = $2, loss_cause = $2, loss_detail = $3::jsonb, loss_at = now(), removal_count = removal_count + 1
      WHERE waxum_session_id = $1 AND status <> 'removed' AND loss_reason IS NULL
      RETURNING id, tenant_id, label, removal_count
    `, [sessionId, reason, JSON.stringify(lossDetail)])).rows[0];
    const line = updated ?? (await this.db.query<LineRow>(`SELECT id, tenant_id, label, removal_count FROM whatsapp_numbers WHERE waxum_session_id = $1 AND loss_reason = $2`, [sessionId, reason])).rows[0];
    if (!line) return;
    const retired = Number(line.removal_count) >= LINE_RETIRED_AFTER_LOSSES;
    if (updated) {
      await this.record(line, sessionId, type, payload, lossSignal);
      this.logger.warn(`Line ${line.id} (${line.label}) lost: ${reason}, loss ${line.removal_count}${retired ? ', retired' : ''}`);
      const metadata = { reason, ...lossDetail, lossCount: Number(line.removal_count), retired, sessionId, raw: lossSignal.detail.raw ?? null };
      await this.db.query(`
        INSERT INTO number_health_events (tenant_id, number_id, event_type, actor_type, metadata, occurred_at)
        VALUES ($1, $2, $3, 'automatic', $4::jsonb, now())
      `, [line.tenant_id, line.id, reason, JSON.stringify(metadata)]);
      await this.audit.record({ tenantId: line.tenant_id, action: `number.${reason}`, entityType: 'whatsapp_number', entityId: line.id, metadata });
      void this.crmEvents?.recordLine(line.tenant_id, line.id, 'number.status_changed').catch(() => undefined);
    }
    this.gateway.broadcastToOperations({ type: 'operations_changed', reason: 'number_lost', at: new Date().toISOString(), activity: { kind: 'number_lost', numberId: line.id, label: line.label, lossReason: reason, retired } }, line.tenant_id);
  }
}
