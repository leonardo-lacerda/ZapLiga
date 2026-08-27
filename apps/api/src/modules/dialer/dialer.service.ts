import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { SdrGateway } from '../sdrs/sdr.gateway';

type CallResource = {
  token: string;
  numberId: string;
  leadId: string;
  sdrId: string;
  media?: WebSocket;
  browser?: WebSocket;
  mediaActive: boolean;
  answerSignalReceived?: boolean;
  answerAbort?: AbortController;
  answerEventLogged?: boolean;
  browserAudioLogged?: boolean;
  finishing?: boolean;
};

@Injectable()
export class DialerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DialerService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private lastStatusSyncAt = 0;
  private readonly active = new Map<string, CallResource>();
  private readonly finishingCalls = new Set<string>();
  private readonly logs: any[] = [];

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly waxum: WaxumClient,
    @Inject(forwardRef(() => SdrGateway)) private readonly gateway: SdrGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.resetStaleSdrPresence().then(() => this.recoverInterruptedCalls()).then(() => this.tick());
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const resource of this.active.values()) {
      resource.answerAbort?.abort();
      resource.media?.close();
    }
  }

  async getSettings() {
    const result = await this.db.query('SELECT * FROM dialer_settings WHERE id = true');
    return result.rows[0];
  }

  getLogs() { return this.logs.slice(0, 100); }

  private log(message: string, level: 'info' | 'warning' | 'error' = 'info', callId?: string) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), level, message, callId };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    this.gateway.broadcast({ type: 'dialer_log', log: entry });
  }

  async updateSettings(input: Record<string, unknown>) {
    const allowed = [
      'global_max_concurrent_calls', 'max_attempts_per_lead', 'retry_delay_minutes',
      'ring_timeout_seconds', 'default_number_cooldown_seconds',
    ];
    const values: unknown[] = [];
    const sets: string[] = [];
    for (const key of allowed) {
      if (input[key] !== undefined) {
        const value = Math.max(0, Number(input[key]));
        if (!Number.isFinite(value)) continue;
        values.push(Math.floor(value));
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length) await this.db.query(`UPDATE dialer_settings SET ${sets.join(', ')}, id = true WHERE id = true`, values);
    return this.getSettings();
  }

  async start() {
    await this.db.query('UPDATE dialer_settings SET running = true WHERE id = true');
    this.log('Discador iniciado');
    await this.tick();
    return this.getStatus();
  }

  async pause() {
    await this.db.query('UPDATE dialer_settings SET running = false WHERE id = true');
    this.log('Discador pausado');
    return this.getStatus();
  }

  async manualCall(leadId: string) {
    const settings = await this.getSettings();
    const [sdrs, numbers, leads] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.available = true
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `),
      // Manual calls intentionally bypass the number cooldown for the MVP.
      // Redis still enforces the global and per-number concurrent limits.
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE status IN ('connected', 'online', 'ready', 'authenticated') ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`),
      this.db.query(`SELECT * FROM leads WHERE id = $1 AND do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $2`, [leadId, settings.max_attempts_per_lead]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    const number = numbers.rows[0];
    const lead = leads.rows[0];
    if (!lead) throw new Error('Este lead não está elegível para uma chamada manual');
    if (!sdr) throw new Error('Nenhum SDR conectado e disponível');
    if (!number) throw new Error('Nenhum número WhatsApp conectado e fora do cooldown');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id,
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estão ocupados; tente novamente em instantes');
    return this.startReservedCall(sdr, number, lead, settings, token, 'manual');
  }

  async getStatus() {
    const settings = await this.getSettings();
    const counts = await this.db.query(`
      SELECT status, count(*)::int AS count FROM calls
      WHERE created_at > now() - interval '24 hours' GROUP BY status
    `);
    const answered = await this.db.query(`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered
      FROM calls WHERE created_at > now() - interval '24 hours'
    `);
    const [available, leads, numberDetails, queueSummary, queuePreview, activeCalls] = await Promise.all([
      this.db.query(`
        SELECT count(*)::int AS count FROM sdrs s
        WHERE s.available = true
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
      `),
      this.db.query(`SELECT status, count(*)::int AS count FROM leads GROUP BY status`),
      this.db.query(`
        SELECT n.id, n.label, n.status, n.max_concurrent_calls, n.cooldown_seconds,
          n.last_call_ended_at,
          COUNT(c.id)::int AS active_calls,
          CASE WHEN n.last_call_ended_at IS NULL THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM ((n.last_call_ended_at + n.cooldown_seconds * interval '1 second') - now())))::int)
          END AS cooldown_remaining_seconds
        FROM whatsapp_numbers n
        LEFT JOIN calls c ON c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')
        WHERE n.status <> 'removed'
        GROUP BY n.id
        ORDER BY n.created_at DESC
      `),
      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE next_eligible_at <= now())::int AS ready,
          COUNT(*) FILTER (WHERE next_eligible_at > now())::int AS waiting
        FROM leads
        WHERE do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $1
      `, [settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT id, name, phone, status, attempts, next_eligible_at,
          ROW_NUMBER() OVER (ORDER BY next_eligible_at ASC, created_at ASC)::int AS queue_position
        FROM leads
        WHERE do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $1
        ORDER BY next_eligible_at ASC, created_at ASC
        LIMIT 12
      `, [settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT c.id, c.status, c.attempt_number, c.created_at, c.started_at, c.connected_at,
          l.name AS lead_name, l.phone AS lead_phone, n.label AS number_label, s.name AS sdr_name
        FROM calls c
        JOIN leads l ON l.id = c.lead_id
        JOIN whatsapp_numbers n ON n.id = c.number_id
        JOIN sdrs s ON s.id = c.sdr_id
        WHERE c.status IN ('reserved', 'dialing', 'media_active')
        ORDER BY c.created_at ASC
      `),
    ]);
    const queue = queueSummary.rows[0] ?? { total: 0, ready: 0, waiting: 0 };
    const nextLead = queuePreview.rows[0] ?? null;
    const connectedNumbers = numberDetails.rows.filter((row: any) => ['connected', 'online', 'ready', 'authenticated'].includes(String(row.status).toLowerCase()));
    const readyNumbers = connectedNumbers.filter((row: any) => Number(row.cooldown_remaining_seconds) === 0);
    let nextAction = 'Pronto para discar';
    if (!settings.running) nextAction = 'Discador pausado';
    else if (!Number(queue.total)) nextAction = 'Fila vazia';
    else if (!Number(available.rows[0].count)) nextAction = 'Aguardando SDR disponível';
    else if (!connectedNumbers.length) nextAction = 'Aguardando número WhatsApp conectado';
    else if (!readyNumbers.length) nextAction = 'Aguardando cooldown dos números';
    else if (!Number(queue.ready)) nextAction = 'Aguardando horário da próxima tentativa';
    return {
      running: settings.running,
      settings,
      active_calls: this.active.size,
      available_sdrs: available.rows[0].count,
      call_counts_24h: Object.fromEntries(counts.rows.map((row: any) => [row.status, row.count])),
      answered_24h: answered.rows[0].answered,
      answer_rate_24h: answered.rows[0].total ? Math.round((answered.rows[0].answered / answered.rows[0].total) * 100) : 0,
      lead_counts: Object.fromEntries(leads.rows.map((row: any) => [row.status, row.count])),
      queue: { total: Number(queue.total), ready: Number(queue.ready), waiting: Number(queue.waiting), preview: queuePreview.rows },
      numbers: numberDetails.rows,
      active_calls_detail: activeCalls.rows,
      next_action: nextAction,
      next_lead: nextLead,
    };
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.expireReservations();
      if (Date.now() - this.lastStatusSyncAt >= 15000) {
        this.lastStatusSyncAt = Date.now();
        await this.syncNumberStatuses();
      }
      const settings = await this.getSettings();
      if (!settings?.running) return;
      const [sdrs, numbers, leads] = await Promise.all([
        this.db.query(`
          SELECT s.* FROM sdrs s
          WHERE s.available = true
            AND NOT EXISTS (
              SELECT 1 FROM calls c
              WHERE c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
            )
          ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
        `),
        this.db.query(`SELECT * FROM whatsapp_numbers WHERE status IN ('connected', 'online', 'ready', 'authenticated') AND (last_call_ended_at IS NULL OR last_call_ended_at <= now() - (cooldown_seconds * interval '1 second')) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`),
        this.db.query(`SELECT * FROM leads WHERE do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $1 AND next_eligible_at <= now() ORDER BY next_eligible_at ASC, created_at ASC LIMIT 25`, [settings.max_attempts_per_lead]),
      ]);

      for (let i = 0; i < Math.min(sdrs.rows.length, numbers.rows.length, leads.rows.length); i++) {
        const sdr = sdrs.rows[i];
        if (!this.gateway.isConnected(sdr.id)) continue;
        const number = numbers.rows[i % numbers.rows.length];
        const lead = leads.rows[i];
        const token = randomUUID();
        const reserved = await this.redis.reserve({
          token, globalMax: settings.global_max_concurrent_calls,
          numberMax: number.max_concurrent_calls, numberId: number.id,
          leadId: lead.id, sdrId: sdr.id,
          ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
        });
        if (!reserved) continue;

        try {
          await this.startReservedCall(sdr, number, lead, settings, token, 'automatico');
        } catch (error) {
          this.logger.error(`Could not reserve call: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Dialer tick failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async syncNumberStatuses() {
    const result = await this.db.query("SELECT id, waxum_session_id FROM whatsapp_numbers WHERE status <> 'removed'");
    for (const number of result.rows) {
      try {
        const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
        await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3', [status.status, status.phone, number.id]);
      } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode === 404) {
          await this.db.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1`, [number.id]);
        }
        // Waxum may be temporarily unavailable; keep the last status unless
        // the session is definitively missing.
      }
    }
  }

  private async startReservedCall(sdr: any, number: any, lead: any, settings: any, token: string, source: string) {
    const callId = randomUUID();
    const expires = new Date(Date.now() + Number(settings.ring_timeout_seconds) * 1000);
    try {
      await this.db.transaction(async (client) => {
        await client.query(`INSERT INTO calls (id, lead_id, number_id, sdr_id, status, attempt_number, offer_expires_at) VALUES ($1,$2,$3,$4,'reserved',$5,$6)`, [callId, lead.id, number.id, sdr.id, Number(lead.attempts) + 1, expires]);
        await client.query(`UPDATE leads SET status = 'reserved', attempts = attempts + 1 WHERE id = $1`, [lead.id]);
        await client.query(`UPDATE sdrs SET available = false, last_assigned_at = now() WHERE id = $1`, [sdr.id]);
      });
      this.active.set(callId, { token, numberId: number.id, leadId: lead.id, sdrId: sdr.id, mediaActive: false });
      this.log(`Discando ${source} para ${lead.name} via ${number.label}`, 'info', callId);
      const browser = this.gateway.getSocket(sdr.id);
      if (browser) void this.attachMedia(callId, sdr.id, browser);
      return { callId, status: 'reserved' };
    } catch (error) {
      await this.redis.release({ token, numberId: number.id, leadId: lead.id, sdrId: sdr.id });
      throw error;
    }
  }

  private async recoverInterruptedCalls() {
    const result = await this.db.query(`
      SELECT id FROM calls
      WHERE status IN ('reserved', 'dialing', 'media_active')
    `);
    for (const row of result.rows) {
      try {
        await this.finishCall(row.id, 'failed', 'api_restarted');
      } catch (error) {
        this.logger.error(`Could not recover call ${row.id}: ${String(error)}`);
      }
    }
  }

  private async resetStaleSdrPresence() {
    await this.db.query(`UPDATE sdrs SET available = false, session_id = '' WHERE available = true`);
  }

  private async expireReservations() {
    const result = await this.db.query(`SELECT id FROM calls WHERE status = 'reserved' AND offer_expires_at < now()`);
    for (const row of result.rows) await this.finishCall(row.id, 'cancelled', 'sdr_offer_timeout', true);
  }

  async attachMedia(callId: string, sdrId: string, browser: WebSocket) {
    const resource = this.active.get(callId);
    if (!resource || resource.sdrId !== sdrId) return browser.close(1008, 'call not assigned');
    const call = await this.db.query(`SELECT c.*, n.waxum_session_id, n.label, l.name, l.phone FROM calls c JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.id = c.lead_id WHERE c.id = $1`, [callId]);
    if (!call.rows[0]) return browser.close(1008, 'call not found');
    resource.browser = browser;
    resource.answerAbort = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const settings = await this.getSettings();
      void this.waxum.waitForOutgoingAnswer(call.rows[0].waxum_session_id, callId, resource.answerAbort.signal)
        .then((answered) => {
          if (!answered || resource.finishing || resource.mediaActive) return;
          resource.answerSignalReceived = true;
          this.log('Atendimento sinalizado pelo WhatsApp; aguardando mídia pós-atendimento', 'info', callId);
        })
        .catch((error) => {
          if ((error as Error & { name?: string }).name === 'AbortError' || resource.finishing) return;
          this.log(`Não foi possível confirmar o atendimento: ${String(error)}`, 'warning', callId);
        });
      const media = this.waxum.openMedia(call.rows[0].waxum_session_id, call.rows[0].phone);
      resource.media = media;
      timeout = setTimeout(() => {
        if (!resource.mediaActive) void this.finishCall(callId, 'no_answer', 'ring_timeout').catch((error) => this.logger.error(`Could not finish timed out call ${callId}: ${String(error)}`));
      }, Number(settings.ring_timeout_seconds) * 1000);

      media.on('open', () => {
        if (resource.mediaActive && browser.readyState === WebSocket.OPEN) {
          try { browser.send(JSON.stringify({ type: 'media_open' })); } catch { /* browser disconnected */ }
        }
      });
      media.on('message', (data, isBinary) => {
        // Waxum sends a textual `call_started` metadata event on its media
        // socket. Keep that internal event away from the SDR control socket;
        // the API already sent the normalized call_started payload above.
        if (!isBinary) return;
        // Um frame de mídia pode chegar enquanto o WhatsApp ainda está tocando.
        // Ele não confirma atendimento e não deve chegar ao SDR.
        if (!resource.answerSignalReceived) {
          if (!resource.answerEventLogged) {
            resource.answerEventLogged = true;
            this.log('Áudio recebido durante o toque; aguardando confirmação de atendimento', 'info', callId);
          }
          return;
        }
        resource.mediaActive = true;
        void this.db.query(`UPDATE calls SET status = 'media_active', started_at = COALESCE(started_at, now()), connected_at = now() WHERE id = $1`, [callId]);
        this.gateway.sendToSdr(sdrId, {
          type: 'call_started', callId,
          lead: { id: call.rows[0].lead_id, name: call.rows[0].name, phone: call.rows[0].phone },
          number: { id: call.rows[0].number_id, label: call.rows[0].label },
          expiresAt: call.rows[0].offer_expires_at,
        });
        this.gateway.sendToSdr(sdrId, { type: 'media_active', callId });
        if (resource.media?.readyState === WebSocket.OPEN) this.gateway.sendToSdr(sdrId, { type: 'media_open', callId });
        this.log('Cliente aceitou a chamada; áudio liberado para o SDR', 'info', callId);
        if (browser.readyState === WebSocket.OPEN) {
          try { browser.send(data, { binary: true }); } catch { /* browser disconnected */ }
        }
      });
      media.on('error', (error) => {
        if (/unexpected server response:\s*429/i.test(error.message)) {
          this.log('Waxum temporariamente ocupado (limite 429); tentativa devolvida ao lead', 'warning', callId);
          void this.finishCall(callId, 'cancelled', 'waxum_rate_limited')
            .catch((finishError) => this.logger.error(`Could not finish Waxum rate limit for ${callId}: ${String(finishError)}`));
          return;
        }
        this.log(`Erro no Waxum: ${error.message}`, 'error', callId);
        void this.finishCall(callId, 'failed', `waxum_error:${error.message}`).catch((finishError) => this.logger.error(`Could not finish Waxum error for ${callId}: ${String(finishError)}`));
      });
      media.on('unexpected-response', (_request, response) => {
        const statusCode = response.statusCode;
        response.resume();
        if (statusCode === 429) {
          this.log('Waxum temporariamente ocupado (limite 429); tentativa devolvida ao lead', 'warning', callId);
          void this.finishCall(callId, 'cancelled', 'waxum_rate_limited')
            .catch((finishError) => this.logger.error(`Could not finish Waxum rate limit for ${callId}: ${String(finishError)}`));
          return;
        }
        this.log(`Waxum recusou a conexão de mídia (HTTP ${statusCode})`, 'error', callId);
        void this.finishCall(callId, 'failed', `waxum_http_error:${statusCode}`)
          .catch((finishError) => this.logger.error(`Could not finish Waxum HTTP error for ${callId}: ${String(finishError)}`));
      });
      media.on('close', (code, reason) => {
        const detail = reason.toString().trim();
        const closeReason = detail ? `waxum_closed:${code}:${detail}` : `waxum_closed:${code}`;
        void this.finishCall(callId, resource.mediaActive ? 'completed' : 'no_answer', resource.mediaActive ? 'remote_hangup' : closeReason)
          .catch((error) => this.logger.error(`Could not finish closed call ${callId}: ${String(error)}`));
      });
      browser.on('message', (data, isBinary) => {
        if (isBinary && !resource.mediaActive) return;
        if (isBinary && !resource.browserAudioLogged && Buffer.byteLength(data as any) > 0) {
          resource.browserAudioLogged = true;
          this.log(`Audio do microfone recebido (${Buffer.byteLength(data as any)} bytes)`, 'info', callId);
        }
        if (isBinary && media.readyState === WebSocket.OPEN) media.send(data, { binary: true });
      });
      browser.on('close', () => {
        void this.finishCall(callId, resource.mediaActive ? 'failed' : 'cancelled', 'browser_disconnected')
          .catch((error) => this.logger.error(`Could not finish browser-disconnected call ${callId}: ${String(error)}`));
      });
      browser.on('error', () => {
        void this.finishCall(callId, 'failed', 'browser_error')
          .catch((error) => this.logger.error(`Could not finish browser-error call ${callId}: ${String(error)}`));
      });
    } catch (error) {
      await this.finishCall(callId, 'failed', String(error));
    } finally {
      if (timeout) setTimeout(() => clearTimeout(timeout), 0);
    }
  }

  async recordOutcome(callId: string, outcome: string) {
    const resource = this.active.get(callId);
    if (resource) return this.finishCall(callId, ['microphone_denied', 'browser_error'].includes(outcome) ? 'failed' : 'completed', outcome);
    await this.db.query(`UPDATE calls SET outcome = $1 WHERE id = $2`, [outcome, callId]);
    return { ok: true };
  }

  async handleSdrDisconnected(sdrId: string) {
    for (const [callId, resource] of this.active.entries()) {
      if (resource.sdrId === sdrId) await this.finishCall(callId, 'failed', 'sdr_disconnected');
    }
  }

  private async finishCall(callId: string, status: string, reason?: string, forceNoRetry = false) {
    if (this.finishingCalls.has(callId)) return;
    this.finishingCalls.add(callId);
    const resource = this.active.get(callId);
    try {
      if (resource) {
        resource.finishing = true;
        resource.answerAbort?.abort();
        if (resource.media && resource.media.readyState === WebSocket.OPEN) resource.media.close();
      }
      const call = await this.db.query(`SELECT c.*, s.id AS sdr_id, n.id AS number_id, l.attempts, ds.max_attempts_per_lead, ds.retry_delay_minutes FROM calls c JOIN sdrs s ON s.id = c.sdr_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.id = c.lead_id CROSS JOIN dialer_settings ds WHERE c.id = $1`, [callId]);
      if (!call.rows[0]) return;
      const row = call.rows[0];
      if (['completed', 'no_answer', 'failed', 'cancelled'].includes(row.status)) return;
      const outcome = reason ?? status;
      const transientRateLimit = outcome === 'waxum_rate_limited';
      const retryable = !transientRateLimit && ['no_answer', 'failed'].includes(status) && !forceNoRetry && Number(row.attempts) < Number(row.max_attempts_per_lead);
      const finalCallStatus = transientRateLimit ? 'cancelled' : retryable ? 'retry_wait' : status;
      const leadStatus = transientRateLimit ? 'queued' : retryable ? 'retry_wait' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'queued' : status;
      this.log(`Chamada encerrada: ${finalCallStatus} (${outcome})`, transientRateLimit ? 'warning' : finalCallStatus === 'failed' ? 'error' : 'info', callId);
      await this.db.transaction(async (client) => {
        await client.query(`UPDATE calls SET status = $1, ended_at = now(), duration_seconds = CASE WHEN started_at IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - started_at))::int END, outcome = $2, failure_reason = CASE WHEN $4 IN ('failed','no_answer') OR $2 = 'waxum_rate_limited' THEN $2 ELSE failure_reason END WHERE id = $3 AND status NOT IN ('completed','no_answer','failed','cancelled')`, [finalCallStatus, outcome, callId, status]);
        if (transientRateLimit) {
          await client.query(`UPDATE leads SET status = 'queued', attempts = GREATEST(0, attempts - 1), next_eligible_at = now() + interval '10 seconds' WHERE id = $1`, [row.lead_id]);
        } else if (retryable) {
          await client.query(`UPDATE leads SET status = $2, next_eligible_at = now() + ($1::int * interval '1 minute') WHERE id = $3`, [row.retry_delay_minutes, leadStatus, row.lead_id]);
        } else {
          await client.query(`UPDATE leads SET status = $1, next_eligible_at = now() WHERE id = $2`, [leadStatus, row.lead_id]);
        }
        await client.query(`UPDATE sdrs SET available = true WHERE id = $1`, [row.sdr_id]);
        if (!transientRateLimit) await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() WHERE id = $1`, [row.number_id]);
      });
      if (resource) await this.redis.release({ token: resource.token, numberId: resource.numberId, leadId: resource.leadId, sdrId: resource.sdrId });
      this.gateway.sendToSdr(row.sdr_id, { type: 'call_finished', callId, status: finalCallStatus, outcome });
    } finally {
      this.active.delete(callId);
      this.finishingCalls.delete(callId);
    }
  }
}
