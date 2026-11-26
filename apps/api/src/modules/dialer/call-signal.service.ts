import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';

// A logout, stream error or call ack this soon after a line's offer is read as WhatsApp's answer to it
// (devices were removed 1.4-3.8 s after the offer, 2026-11-25).
const OFFER_WINDOW_SECONDS = 120;
const DETAIL_MAX_CHARS = 4000;

/**
 * Stores every WhatsApp signal around a call in `call_signal_events` (migration 078): the
 * answers to the offer (Waxum's `incoming_call` events carry every `<call>` stanza, ours
 * included), the server's acks of our call stanzas (`call_ack`, with its error, e.g. 463: Waxum v8)
 * and the logouts and stream errors of the line right after an offer, each with the ms since the offer. One API instance stores each event (NATS queue group).
 */
@Injectable()
export class CallSignalService implements OnModuleInit {
  private readonly logger = new Logger(CallSignalService.name);

  constructor(private readonly db: DatabaseService, private readonly waxum: WaxumClient) {}

  onModuleInit() {
    void this.waxum.subscribeSessionEvents(['incoming_call', 'call_ack', 'logged_out', 'stream_error', 'account_locked'], (sessionId, type, payload) => this.store(sessionId, type, payload), 'zapliga-call-signals')
      .catch((error) => this.logger.error(`Call signals not subscribed: ${String((error as Error)?.message ?? error).slice(0, 300)}`));
  }

  async store(sessionId: string, type: string, payload: any) {
    const line = (await this.db.query('SELECT id, tenant_id FROM whatsapp_numbers WHERE waxum_session_id = $1 LIMIT 1', [sessionId])).rows[0];
    if (!line) return;
    const data = payload?.data ?? {};
    const waxumCallId = type === 'incoming_call' && data.call_id ? String(data.call_id) : null;
    const call = waxumCallId
      ? (await this.db.query('SELECT id, offer_sent_at FROM calls WHERE tenant_id = $1 AND waxum_call_id = $2 LIMIT 1', [line.tenant_id, waxumCallId])).rows[0]
      : (await this.db.query(`
          SELECT id, offer_sent_at, waxum_call_id FROM calls
          WHERE tenant_id = $1 AND number_id = $2 AND offer_sent_at > now() - make_interval(secs => $3)
          ORDER BY offer_sent_at DESC LIMIT 1
        `, [line.tenant_id, line.id, OFFER_WINDOW_SECONDS])).rows[0];
    // `incoming_call` carries the stanza as `action: "<Kind> { ... }"`; the kind leads it.
    const kind = type === 'incoming_call' ? `call_${String(data.action ?? '').match(/^\w+/)?.[0]?.toLowerCase() ?? 'unknown'}` : type;
    const msSinceOffer = call?.offer_sent_at ? Date.now() - new Date(call.offer_sent_at).getTime() : null;
    const detail = JSON.stringify(data).slice(0, DETAIL_MAX_CHARS);
    await this.db.query(`
      INSERT INTO call_signal_events (tenant_id, number_id, call_id, waxum_call_id, kind, ms_since_offer, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [line.tenant_id, line.id, call?.id ?? null, waxumCallId ?? call?.waxum_call_id ?? null, kind, msSinceOffer, detail.length < DETAIL_MAX_CHARS ? detail : JSON.stringify({ truncated: detail })]);
  }
}
