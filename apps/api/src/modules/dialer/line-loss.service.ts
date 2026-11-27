import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { CrmEventsService } from '../crm-events/crm-events.service';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { LINE_RETIRED_AFTER_LOSSES } from './dialer.rules';
import { LINE_LOSS_EVENT_TYPES, LINE_OUT_CAUSES, LineLossSignal, classifyLineLoss, lineLossEventId } from './line-loss.rules';

interface LineRow {
  id: string;
  tenant_id: string;
  label: string;
  removal_count?: number;
}

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
    const line = (await this.db.query<LineRow>(`SELECT id, tenant_id, label FROM whatsapp_numbers WHERE waxum_session_id = $1 AND status <> 'removed' LIMIT 1`, [sessionId])).rows[0];
    if (!line) return;
    if (await this.record(line, sessionId, type, payload, lossSignal)) {
      this.logger.log(`Line ${line.id} (${line.label}): ${lossSignal.cause}${lossSignal.code ? ` (${lossSignal.code})` : ''}`);
    }
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
