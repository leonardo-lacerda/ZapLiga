import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { AuditService } from '../audit/audit.service';
import { CrmEventsService } from '../crm-events/crm-events.service';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { LINE_RETIRED_AFTER_LOSSES } from './dialer.rules';

export type LineLossReason = 'device_removed' | 'account_locked';

/**
 * The Waxum event that means WhatsApp took the line away. `account_locked` is its own event;
 * a removed device arrives as `logged_out` carrying the `<conflict type="device_removed">`
 * of the stream error (docs/waxum-version.md). Other logouts are not a loss.
 */
export function lineLossReason(type: string, payload: any): LineLossReason | null {
  if (type === 'account_locked') return 'account_locked';
  if (type === 'logged_out' && payload?.data?.conflict === 'device_removed') return 'device_removed';
  return null;
}

/**
 * Marks a line WhatsApp removed or locked: it leaves the dialer and the egress pool, the
 * operators see why, and a line lost LINE_RETIRED_AFTER_LOSSES times is retired (no new QR).
 * Both API instances get the event; only one writes, both tell their own dashboards.
 */
@Injectable()
export class LineLossService implements OnModuleInit {
  private readonly logger = new Logger(LineLossService.name);

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient, private readonly audit: AuditService, private readonly gateway: SdrGateway, @Optional() private readonly crmEvents?: CrmEventsService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    void this.waxum.subscribeSessionEvents(['account_locked', 'logged_out'], (sessionId, type, payload) => this.handle(sessionId, type, payload))
      .catch((error) => this.logger.error(`Line loss events not subscribed: ${String((error as Error)?.message ?? error).slice(0, 300)}`));
  }

  async handle(sessionId: string, type: string, payload: any) {
    const reason = lineLossReason(type, payload);
    if (!reason) return;
    const updated = (await this.db.query(`
      UPDATE whatsapp_numbers SET loss_reason = $2, loss_at = now(), removal_count = removal_count + 1
      WHERE waxum_session_id = $1 AND status <> 'removed' AND loss_reason IS NULL
      RETURNING id, tenant_id, label, removal_count
    `, [sessionId, reason])).rows[0];
    const line = updated ?? (await this.db.query(`SELECT id, tenant_id, label, removal_count FROM whatsapp_numbers WHERE waxum_session_id = $1 AND loss_reason = $2`, [sessionId, reason])).rows[0];
    if (!line) return;
    const retired = Number(line.removal_count) >= LINE_RETIRED_AFTER_LOSSES;
    if (updated) {
      this.logger.warn(`Line ${line.id} (${line.label}) lost: ${reason}, loss ${line.removal_count}${retired ? ', retired' : ''}`);
      const metadata = { reason, lossCount: Number(line.removal_count), retired, sessionId, raw: payload?.data?.raw ?? null };
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
