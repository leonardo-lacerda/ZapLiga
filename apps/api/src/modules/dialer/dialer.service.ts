import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import WebSocket, { RawData } from 'ws';
import { DatabaseService } from '../../database/database.service';
import { legacyTenantId } from '../../database/tenant-context';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { SdrGateway } from '../sdrs/sdr.gateway';

type CallResource = {
  tenantId: string;
  token: string;
  numberId: string;
  leadId: string;
  sdrId: string;
  media?: WebSocket;
  browser?: WebSocket;
  mediaActive: boolean;
  mediaOpen?: boolean;
  answerSignalReceived?: boolean;
  answerAbort?: AbortController;
  answerWatcherStarted?: boolean;
  sdrNotified?: boolean;
  waxumCallId?: string;
  answerEventLogged?: boolean;
  browserAudioLogged?: boolean;
  ringTimeout?: NodeJS.Timeout;
  browserMessageHandler?: (data: RawData, isBinary: boolean) => void;
  browserCloseHandler?: () => void;
  browserErrorHandler?: () => void;
  finishing?: boolean;
};

@Injectable()
export class DialerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DialerService.name);
  private timer?: NodeJS.Timeout;
  private readonly ticking = new Set<string>();
  private readonly lastStatusSyncAt = new Map<string, number>();
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
    this.timer = setInterval(() => void this.tickAllTenants(), 1000);
    void this.resetStaleSdrPresence().then(() => this.recoverInterruptedCalls()).then(() => this.tickAllTenants());
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const resource of this.active.values()) {
      resource.answerAbort?.abort();
      resource.media?.close();
    }
  }

  async getSettings(tenantId = legacyTenantId()) {
    const result = await this.db.query('SELECT * FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
    return result.rows[0];
  }

  getLogs(tenantId = legacyTenantId()) { return this.logs.filter((entry) => entry.tenantId === tenantId).slice(0, 100); }

  async getSdrState(sdrId: string, tenantId = legacyTenantId()) {
    const result = await this.db.query(`
      SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
        p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
        c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
        c.connected_at AS pause_call_started_at
      FROM sdrs s
      LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
      LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
      LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
      WHERE s.tenant_id = $1 AND s.id = $2
    `, [tenantId, sdrId]);
    return result.rows[0] ?? null;
  }

  async setAvailability(sdrId: string, available: boolean, tenantId = legacyTenantId()) {
    const sdr = await this.getSdrState(sdrId, tenantId);
    if (!sdr) throw new Error('SDR não encontrado');
    if (available && sdr.current_pause_id) throw new Error('Finalize o pós-atendimento antes de ficar disponível');
    if (available) {
      const active = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND sdr_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, sdrId]);
      if (active.rows[0]) throw new Error('O SDR ainda está em uma chamada');
    }
    const state = available ? 'available' : 'offline';
    await this.db.query('UPDATE sdrs SET available = $1, state = $2 WHERE tenant_id = $3 AND id = $4', [available, state, tenantId, sdrId]);
    this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state, available }, tenantId);
    return this.getSdrState(sdrId, tenantId);
  }

  async finishPause(sdrId: string, pauseId: string, input: { callResult?: string; pipelineStage?: string; notes?: string }, tenantId = legacyTenantId()) {
    const callResult = String(input.callResult ?? '').trim();
    const pipelineStage = String(input.pipelineStage ?? '').trim();
    const notes = String(input.notes ?? '').trim();
    if (!callResult || !pipelineStage || !notes) throw new Error('Resultado, etapa da tubulação e anotação são obrigatórios');
    return this.db.transaction(async (client) => {
      const pauseResult = await client.query(`SELECT p.*, c.lead_id FROM sdr_pauses p LEFT JOIN calls c ON c.tenant_id = p.tenant_id AND c.id = p.call_id WHERE p.tenant_id = $1 AND p.id = $2 AND p.sdr_id = $3 FOR UPDATE`, [tenantId, pauseId, sdrId]);
      const pause = pauseResult.rows[0];
      if (!pause) throw new Error('Pausa não encontrada');
      if (pause.ended_at) throw new Error('Esta pausa já foi encerrada');
      const endedAt = new Date();
      await client.query(`UPDATE sdr_pauses SET ended_at = $1, duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($1 - started_at))::int) WHERE tenant_id = $2 AND id = $3`, [endedAt, tenantId, pauseId]);
      if (pause.call_id) {
        await client.query(`UPDATE calls SET call_result = $1, pipeline_stage = $2, notes = $3, wrap_up_completed_at = $4 WHERE tenant_id = $5 AND id = $6`, [callResult, pipelineStage, notes, endedAt, tenantId, pause.call_id]);
        await client.query(`UPDATE leads SET pipeline_stage = $1 WHERE tenant_id = $2 AND id = $3`, [pipelineStage, tenantId, pause.lead_id]);
      }
      await client.query(`UPDATE sdrs SET available = true, state = 'available', current_pause_id = NULL WHERE tenant_id = $1 AND id = $2 AND current_pause_id = $3`, [tenantId, sdrId, pauseId]);
      return { id: pauseId, ended_at: endedAt.toISOString(), duration_seconds: Math.max(0, Math.floor((endedAt.getTime() - new Date(pause.started_at).getTime()) / 1000)), call_result: callResult, pipeline_stage: pipelineStage, notes };
    }).then((result) => {
      this.gateway.sendToSdr(sdrId, { type: 'pause_finished', pauseId, state: 'available' });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state: 'available', available: true }, tenantId);
      return result;
    });
  }

  private log(message: string, level: 'info' | 'warning' | 'error' = 'info', callId?: string, tenantId = legacyTenantId()) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), level, message, callId, tenantId };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    this.gateway.broadcast({ type: 'dialer_log', log: entry }, tenantId);
  }

  async updateSettings(input: Record<string, unknown>, tenantId = legacyTenantId()) {
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
    if (sets.length) await this.db.query(`UPDATE dialer_settings SET ${sets.join(', ')} WHERE tenant_id = $${values.length + 1}`, [...values, tenantId]);
    return this.getSettings(tenantId);
  }

  async start(tenantId = legacyTenantId()) {
    await this.db.query('UPDATE dialer_settings SET running = true WHERE tenant_id = $1', [tenantId]);
    this.log('Discador iniciado', 'info', undefined, tenantId);
    await this.tick(tenantId);
    return this.getStatus(tenantId);
  }

  async pause(tenantId = legacyTenantId()) {
    await this.db.query('UPDATE dialer_settings SET running = false WHERE tenant_id = $1', [tenantId]);
    this.log('Discador pausado', 'info', undefined, tenantId);
    return this.getStatus(tenantId);
  }

  async manualCall(leadId: string, tenantId = legacyTenantId()) {
    const settings = await this.getSettings(tenantId);
    const [sdrs, numbers, leads] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `, [tenantId]),
      // Manual calls intentionally bypass the number cooldown for the MVP.
      // Redis still enforces the global and per-number concurrent limits.
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
      this.db.query(`SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $3`, [tenantId, leadId, settings.max_attempts_per_lead]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    const number = numbers.rows[0];
    const lead = leads.rows[0];
    if (!lead) throw new Error('Este lead não está elegível para uma chamada manual');
    if (!sdr) throw new Error('Nenhum SDR conectado e disponível');
    if (!number) throw new Error('Nenhum número WhatsApp conectado e fora do cooldown');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      tenantId, token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id,
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estão ocupados; tente novamente em instantes');
    return this.startReservedCall(sdr, number, lead, settings, token, 'manual', tenantId);
  }

  async getStatus(tenantId = legacyTenantId()) {
    const settings = await this.getSettings(tenantId);
    const counts = await this.db.query(`
      SELECT status, count(*)::int AS count FROM calls
      WHERE tenant_id = $1 AND created_at > now() - interval '24 hours' GROUP BY status
    `, [tenantId]);
    const answered = await this.db.query(`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered
      FROM calls WHERE tenant_id = $1 AND created_at > now() - interval '24 hours'
    `, [tenantId]);
    const [available, leads, numberDetails, queueSummary, queuePreview, activeCalls, sdrDetails] = await Promise.all([
      this.db.query(`
        SELECT count(*)::int AS count FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
      `, [tenantId]),
      this.db.query(`SELECT status, count(*)::int AS count FROM leads WHERE tenant_id = $1 GROUP BY status`, [tenantId]),
      this.db.query(`
        SELECT n.id, n.label, n.status, n.max_concurrent_calls, n.cooldown_seconds,
          n.last_call_ended_at,
          COUNT(c.id)::int AS active_calls,
          CASE WHEN n.last_call_ended_at IS NULL THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM ((n.last_call_ended_at + n.cooldown_seconds * interval '1 second') - now())))::int)
          END AS cooldown_remaining_seconds
        FROM whatsapp_numbers n
        LEFT JOIN calls c ON c.tenant_id = n.tenant_id AND c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')
        WHERE n.tenant_id = $1 AND n.status <> 'removed'
        GROUP BY n.id
        ORDER BY n.created_at DESC
      `, [tenantId]),
      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE next_eligible_at <= now())::int AS ready,
          COUNT(*) FILTER (WHERE next_eligible_at > now())::int AS waiting
        FROM leads
        WHERE tenant_id = $1 AND do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $2
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT id, name, phone, status, attempts, next_eligible_at,
          ROW_NUMBER() OVER (ORDER BY next_eligible_at ASC, created_at ASC)::int AS queue_position
        FROM leads
        WHERE tenant_id = $1 AND do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $2
        ORDER BY next_eligible_at ASC, created_at ASC
        LIMIT 12
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT c.id, c.status, c.attempt_number, c.created_at, c.started_at, c.connected_at,
          GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(c.connected_at, c.started_at, c.created_at)))::int) AS elapsed_seconds,
          l.name AS lead_name, l.phone AS lead_phone, n.label AS number_label, s.name AS sdr_name
        FROM calls c
        JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        JOIN whatsapp_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.number_id
        JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id
        WHERE c.tenant_id = $1 AND c.status IN ('reserved', 'dialing', 'media_active')
        ORDER BY c.created_at ASC
      `, [tenantId]),
      this.db.query(`
        SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
          p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
          c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
          c.connected_at AS pause_call_started_at,
          CASE WHEN p.started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - p.started_at))::int) END AS pause_elapsed_seconds
        FROM sdrs s
        LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
        LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
        LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        WHERE s.tenant_id = $1
        ORDER BY s.name
      `, [tenantId]),
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
      active_calls: Array.from(this.active.values()).filter((resource) => resource.tenantId === tenantId).length,
      available_sdrs: available.rows[0].count,
      call_counts_24h: Object.fromEntries(counts.rows.map((row: any) => [row.status, row.count])),
      answered_24h: answered.rows[0].answered,
      answer_rate_24h: answered.rows[0].total ? Math.round((answered.rows[0].answered / answered.rows[0].total) * 100) : 0,
      lead_counts: Object.fromEntries(leads.rows.map((row: any) => [row.status, row.count])),
      sdrs: sdrDetails.rows,
      post_call_sdrs: sdrDetails.rows.filter((row: any) => row.state === 'post_call'),
      queue: { total: Number(queue.total), ready: Number(queue.ready), waiting: Number(queue.waiting), preview: queuePreview.rows },
      numbers: numberDetails.rows,
      active_calls_detail: activeCalls.rows,
      next_action: nextAction,
      next_lead: nextLead,
    };
  }

  async getSdrStatus(tenantId: string, userId: string) {
    const [settings, sdr] = await Promise.all([
      this.getSettings(tenantId),
      this.db.query(`SELECT id, name, available, state, current_pause_id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [tenantId, userId]),
    ]);
    return { running: Boolean(settings?.running), sdr: sdr.rows[0] ?? null };
  }

  async tick(tenantId = legacyTenantId()) {
    const tickToken = randomUUID();
    const tickLock = `zapcall:tenant:${tenantId}:lock:dialer-tick`;
    if (!await this.redis.acquireLock(tickLock, tickToken, 30_000)) return;
    if (this.ticking.has(tenantId)) { await this.redis.releaseLock(tickLock, tickToken); return; }
    this.ticking.add(tenantId);
    try {
      await this.expireReservations(tenantId);
      const lastStatusSyncAt = this.lastStatusSyncAt.get(tenantId) ?? 0;
      if (Date.now() - lastStatusSyncAt >= 15000) {
        this.lastStatusSyncAt.set(tenantId, Date.now());
        await this.syncNumberStatuses(tenantId);
      }
      const settings = await this.getSettings(tenantId);
      if (!settings?.running) return;
      const [sdrs, numbers, leads] = await Promise.all([
        this.db.query(`
            SELECT s.* FROM sdrs s
            WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM calls c
                WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
            )
          ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
        `, [tenantId]),
        this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (last_call_ended_at IS NULL OR last_call_ended_at <= now() - (cooldown_seconds * interval '1 second')) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
        this.db.query(`SELECT * FROM leads WHERE tenant_id = $1 AND do_not_call = false AND status IN ('queued', 'retry_wait') AND attempts < $2 AND next_eligible_at <= now() ORDER BY next_eligible_at ASC, created_at ASC LIMIT 25`, [tenantId, settings.max_attempts_per_lead]),
      ]);

      for (let i = 0; i < Math.min(sdrs.rows.length, numbers.rows.length, leads.rows.length); i++) {
        const sdr = sdrs.rows[i];
        if (!this.gateway.isConnected(sdr.id)) continue;
        const number = numbers.rows[i % numbers.rows.length];
        const lead = leads.rows[i];
        const token = randomUUID();
        const reserved = await this.redis.reserve({
          tenantId, token, globalMax: settings.global_max_concurrent_calls,
          numberMax: number.max_concurrent_calls, numberId: number.id,
          leadId: lead.id, sdrId: sdr.id,
          ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
        });
        if (!reserved) continue;

        try {
          await this.startReservedCall(sdr, number, lead, settings, token, 'automatico', tenantId);
        } catch (error) {
          this.logger.error(`Could not reserve call: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Dialer tick failed: ${String(error)}`);
    } finally {
      this.ticking.delete(tenantId);
      await this.redis.releaseLock(tickLock, tickToken);
    }
  }

  private async tickAllTenants() {
    const result = await this.db.query("SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
    for (const tenant of result.rows) await this.tick(tenant.id);
  }

  private async syncNumberStatuses(tenantId = legacyTenantId()) {
    const result = await this.db.query("SELECT id, tenant_id, waxum_session_id FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId]);
    for (const number of result.rows) {
      try {
        const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
        await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE tenant_id = $3 AND id = $4', [status.status, status.phone, tenantId, number.id]);
      } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode === 404) {
          await this.db.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE tenant_id = $1 AND id = $2`, [tenantId, number.id]);
        }
        // Waxum may be temporarily unavailable; keep the last status unless
        // the session is definitively missing.
      }
    }
  }

  private async startReservedCall(sdr: any, number: any, lead: any, settings: any, token: string, source: string, tenantId = legacyTenantId()) {
    const callId = randomUUID();
    const expires = new Date(Date.now() + Number(settings.ring_timeout_seconds) * 1000);
    try {
      await this.db.transaction(async (client) => {
        await client.query(`INSERT INTO calls (id, tenant_id, lead_id, number_id, sdr_id, status, attempt_number, offer_expires_at) VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7)`, [callId, tenantId, lead.id, number.id, sdr.id, Number(lead.attempts) + 1, expires]);
        await client.query(`UPDATE leads SET status = 'reserved', attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2`, [tenantId, lead.id]);
        await client.query(`UPDATE sdrs SET available = false, state = 'in_call', last_assigned_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, sdr.id]);
      });
      this.active.set(callId, { tenantId, token, numberId: number.id, leadId: lead.id, sdrId: sdr.id, mediaActive: false });
      this.log(`Discando ${source} para ${lead.name} via ${number.label}`, 'info', callId, tenantId);
      const browser = this.gateway.getSocket(sdr.id);
      this.gateway.sendToSdr(sdr.id, { type: 'call_reserved', callId, lead: { id: lead.id, name: lead.name, phone: lead.phone }, number: { id: number.id, label: number.label } });
      if (browser) void this.attachMedia(callId, sdr.id, browser);
      return { callId, status: 'reserved' };
    } catch (error) {
      await this.redis.release({ tenantId, token, numberId: number.id, leadId: lead.id, sdrId: sdr.id });
      throw error;
    }
  }

  private async recoverInterruptedCalls() {
    const result = await this.db.query(`
      SELECT id, tenant_id FROM calls
      WHERE status IN ('reserved', 'dialing', 'media_active')
    `);
    for (const row of result.rows) {
      try {
        await this.finishCall(row.id, 'failed', 'api_restarted', false, row.tenant_id);
      } catch (error) {
        this.logger.error(`Could not recover call ${row.id}: ${String(error)}`);
      }
    }
  }

  private async resetStaleSdrPresence() {
    await this.db.query(`UPDATE sdrs SET available = false, session_id = '', state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END`);
  }

  private async expireReservations(tenantId = legacyTenantId()) {
    const result = await this.db.query(`SELECT id FROM calls WHERE tenant_id = $1 AND status = 'reserved' AND offer_expires_at < now()`, [tenantId]);
    for (const row of result.rows) await this.finishCall(row.id, 'cancelled', 'sdr_offer_timeout', true, tenantId);
  }

  private notifyAnswered(callId: string, sdrId: string, row: any, resource: CallResource) {
    if (resource.sdrNotified || resource.finishing) return;
    resource.sdrNotified = true;
    this.gateway.sendToSdr(sdrId, {
      type: 'call_started', callId,
      lead: { id: row.lead_id, name: row.name, phone: row.phone },
      number: { id: row.number_id, label: row.label },
      connectedAt: new Date().toISOString(),
      expiresAt: row.offer_expires_at,
    });
    if (resource.media?.readyState === WebSocket.OPEN) this.gateway.sendToSdr(sdrId, { type: 'media_open', callId });
  }

  async attachMedia(callId: string, sdrId: string, browser: WebSocket, tenantId = legacyTenantId()) {
    const resource = this.active.get(callId);
    if (!resource || resource.tenantId !== tenantId || resource.sdrId !== sdrId) return browser.close(1008, 'call not assigned');
    const call = await this.db.query(`SELECT c.*, n.waxum_session_id, n.label, l.name, l.phone FROM calls c JOIN whatsapp_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
    if (!call.rows[0]) return browser.close(1008, 'call not found');
    resource.browser = browser;
    resource.answerAbort = new AbortController();
    try {
      const settings = await this.getSettings(tenantId);
      let recipient: string;
      try {
        recipient = await this.waxum.resolveCallRecipient(call.rows[0].waxum_session_id, call.rows[0].phone);
        this.log(`Destinatario VoIP resolvido para ${recipient}`, 'info', callId);
      } catch (error) {
        const message = String((error as Error).message ?? error);
        this.log(`Waxum nao conseguiu preparar o destinatario: ${message}`, 'error', callId);
        await this.finishCall(callId, 'failed', `waxum_recipient_error:${message}`);
        return;
      }
      if (resource.finishing) return;
      const media = this.waxum.openMedia(call.rows[0].waxum_session_id, recipient);
      resource.media = media;
      resource.ringTimeout = setTimeout(() => {
        if (!resource.mediaActive && !resource.answerSignalReceived) void this.finishCall(callId, 'no_answer', 'ring_timeout').catch((error) => this.logger.error(`Could not finish timed out call ${callId}: ${String(error)}`));
      }, Number(settings.ring_timeout_seconds) * 1000);

      media.on('open', () => {
        resource.mediaOpen = true;
        if (browser.readyState === WebSocket.OPEN) {
          try { browser.send(JSON.stringify({ type: 'media_open' })); } catch { /* browser disconnected */ }
        }
      });
      media.on('message', (data, isBinary) => {
        // Waxum generates its own call id. It is different from the ZapLiga
        // database id and is the id carried by WhatsApp Accept events.
        if (!isBinary) {
          try {
            const metadata = JSON.parse(data.toString()) as { type?: string; call_id?: string };
            if (metadata.type === 'call_started' && metadata.call_id && !resource.answerWatcherStarted) {
              resource.waxumCallId = metadata.call_id;
              resource.answerWatcherStarted = true;
              this.log(`Chamada Waxum iniciada (${metadata.call_id}); aguardando atendimento`, 'info', callId);
              void this.waxum.waitForOutgoingAnswer(call.rows[0].waxum_session_id, metadata.call_id, resource.answerAbort!.signal)
                .then((answered) => {
                  if (!answered || resource.finishing || resource.mediaActive) return;
                  resource.answerSignalReceived = true;
                  this.notifyAnswered(callId, sdrId, call.rows[0], resource);
                  this.log('Atendimento sinalizado pelo WhatsApp; aguardando mídia pós-atendimento', 'info', callId);
                })
                .catch((error) => {
                  if ((error as Error & { name?: string }).name === 'AbortError' || resource.finishing) return;
                  this.log(`Não foi possível confirmar o atendimento: ${String(error)}`, 'warning', callId);
                });
            }
          } catch (error) {
            this.log(`Metadados de mídia inválidos: ${String(error)}`, 'warning', callId);
          }
          return;
        }
        // Um frame de mídia pode chegar enquanto o WhatsApp ainda está tocando.
        // Ele não confirma atendimento e não deve chegar ao SDR.
        if (!resource.answerSignalReceived) {
          if (!resource.answerEventLogged) {
            resource.answerEventLogged = true;
            this.log('Áudio recebido durante o toque; aguardando confirmação de atendimento', 'info', callId);
          }
          return;
        }
        const firstActiveFrame = !resource.mediaActive;
        resource.mediaActive = true;
        if (firstActiveFrame) {
          if (resource.ringTimeout) clearTimeout(resource.ringTimeout);
          resource.ringTimeout = undefined;
          void this.db.query(`UPDATE calls SET status = 'media_active', started_at = COALESCE(started_at, now()), connected_at = now() WHERE tenant_id = $1 AND id = $2`, [resource.tenantId, callId]);
          this.notifyAnswered(callId, sdrId, call.rows[0], resource);
          this.gateway.sendToSdr(sdrId, { type: 'media_active', callId });
          this.log('Cliente aceitou a chamada; áudio liberado para o SDR', 'info', callId);
        }
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
      resource.browserMessageHandler = (data, isBinary) => {
        // Start forwarding microphone PCM as soon as Waxum accepts the media
        // socket. Waiting for the first inbound frame can deadlock the bridge:
        // some calls only produce inbound audio after receiving an uplink
        // frame from the browser.
        if (isBinary && !resource.mediaOpen) return;
        if (isBinary && !resource.browserAudioLogged && Buffer.byteLength(data as any) > 0) {
          resource.browserAudioLogged = true;
          this.log(`Audio do microfone recebido (${Buffer.byteLength(data as any)} bytes)`, 'info', callId);
        }
        if (isBinary && media.readyState === WebSocket.OPEN) media.send(data, { binary: true });
      };
      resource.browserCloseHandler = () => {
        void this.finishCall(callId, resource.mediaActive ? 'failed' : 'cancelled', 'browser_disconnected')
          .catch((error) => this.logger.error(`Could not finish browser-disconnected call ${callId}: ${String(error)}`));
      };
      resource.browserErrorHandler = () => {
        void this.finishCall(callId, 'failed', 'browser_error')
          .catch((error) => this.logger.error(`Could not finish browser-error call ${callId}: ${String(error)}`));
      };
      browser.on('message', resource.browserMessageHandler);
      browser.on('close', resource.browserCloseHandler);
      browser.on('error', resource.browserErrorHandler);
    } catch (error) {
      await this.finishCall(callId, 'failed', String(error));
    }
  }

  async recordOutcome(callId: string, outcome: string, tenantId = legacyTenantId(), sdrId?: string) {
    const resource = this.active.get(callId);
    if (resource && (resource.tenantId !== tenantId || (sdrId && resource.sdrId !== sdrId))) throw new Error('Chamada não pertence ao SDR autenticado');
    const isBrowserAudioFailure = outcome === 'microphone_denied' || outcome === 'browser_error' || outcome.startsWith('audio_error:');
    if (resource) return this.finishCall(callId, isBrowserAudioFailure ? 'failed' : 'completed', outcome);
    const ownership = sdrId ? ' AND sdr_id = $4' : '';
    await this.db.query(`UPDATE calls SET outcome = $1 WHERE tenant_id = $2 AND id = $3${ownership}`, sdrId ? [outcome, tenantId, callId, sdrId] : [outcome, tenantId, callId]);
    return { ok: true };
  }

  async handleSdrDisconnected(sdrId: string, tenantId = legacyTenantId()) {
    for (const [callId, resource] of this.active.entries()) {
      if (resource.tenantId === tenantId && resource.sdrId === sdrId) await this.finishCall(callId, 'failed', 'sdr_disconnected', false, tenantId);
    }
    await this.db.query(`UPDATE sdrs SET available = false, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END WHERE tenant_id = $1 AND id = $2`, [tenantId, sdrId]);
  }

  private async finishCall(callId: string, status: string, reason?: string, forceNoRetry = false, tenantId = legacyTenantId()) {
    if (this.finishingCalls.has(callId)) return;
    this.finishingCalls.add(callId);
    const resource = this.active.get(callId);
    try {
      if (resource) {
        tenantId = resource.tenantId;
        resource.finishing = true;
        resource.answerAbort?.abort();
        if (resource.ringTimeout) clearTimeout(resource.ringTimeout);
        if (resource.browser && resource.browserMessageHandler) resource.browser.off('message', resource.browserMessageHandler);
        if (resource.browser && resource.browserCloseHandler) resource.browser.off('close', resource.browserCloseHandler);
        if (resource.browser && resource.browserErrorHandler) resource.browser.off('error', resource.browserErrorHandler);
        if (resource.media && resource.media.readyState === WebSocket.OPEN) resource.media.close();
      }
      const call = await this.db.query(`SELECT c.*, s.id AS sdr_id, n.id AS number_id, l.attempts, ds.max_attempts_per_lead, ds.retry_delay_minutes FROM calls c JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id JOIN whatsapp_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN dialer_settings ds ON ds.tenant_id = c.tenant_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
      if (!call.rows[0]) return;
      const row = call.rows[0];
      if (['completed', 'no_answer', 'failed', 'cancelled'].includes(row.status)) return;
      const outcome = reason ?? status;
      const transientRateLimit = outcome === 'waxum_rate_limited';
      const retryable = !transientRateLimit && ['no_answer', 'failed'].includes(status) && !forceNoRetry && Number(row.attempts) < Number(row.max_attempts_per_lead);
      const finalCallStatus = transientRateLimit ? 'cancelled' : retryable ? 'retry_wait' : status;
      const leadStatus = transientRateLimit ? 'queued' : retryable ? 'retry_wait' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'queued' : status;
      const requiresPostCall = Boolean(row.connected_at);
      let pause: any = null;
      this.log(`Chamada encerrada: ${finalCallStatus} (${outcome})`, transientRateLimit ? 'warning' : finalCallStatus === 'failed' ? 'error' : 'info', callId);
      await this.db.transaction(async (client) => {
        await client.query(`UPDATE calls SET status = $1, ended_at = now(), duration_seconds = CASE WHEN COALESCE(connected_at, started_at) IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - COALESCE(connected_at, started_at)))::int END, outcome = $2, failure_reason = CASE WHEN $4 IN ('failed','no_answer') OR $2 = 'waxum_rate_limited' THEN $2 ELSE failure_reason END WHERE tenant_id = $5 AND id = $3 AND status NOT IN ('completed','no_answer','failed','cancelled')`, [finalCallStatus, outcome, callId, status, tenantId]);
        if (transientRateLimit) {
          await client.query(`UPDATE leads SET status = 'queued', attempts = GREATEST(0, attempts - 1), next_eligible_at = now() + interval '10 seconds' WHERE tenant_id = $1 AND id = $2`, [tenantId, row.lead_id]);
        } else if (retryable) {
          await client.query(`UPDATE leads SET status = $2, next_eligible_at = now() + ($1::int * interval '1 minute') WHERE tenant_id = $3 AND id = $4`, [row.retry_delay_minutes, leadStatus, tenantId, row.lead_id]);
        } else {
          await client.query(`UPDATE leads SET status = $1, next_eligible_at = now() WHERE tenant_id = $2 AND id = $3`, [leadStatus, tenantId, row.lead_id]);
        }
        if (requiresPostCall) {
          const pauseId = randomUUID();
          const pauseResult = await client.query(`
            INSERT INTO sdr_pauses (id, tenant_id, sdr_id, call_id, pause_type)
            VALUES ($1, $2, $3, $4, 'post_call')
            RETURNING id, pause_type, started_at
          `, [pauseId, tenantId, row.sdr_id, callId]);
          pause = {
            id: pauseResult.rows[0].id,
            pause_type: pauseResult.rows[0].pause_type,
            started_at: pauseResult.rows[0].started_at,
            call_id: callId,
            lead_name: row.name,
            lead_phone: row.phone,
            call_started_at: row.connected_at,
            call_duration_seconds: row.connected_at ? Math.max(0, Math.floor((Date.now() - new Date(row.connected_at).getTime()) / 1000)) : 0,
          };
          await client.query(`UPDATE sdrs SET available = false, state = 'post_call', current_pause_id = $1 WHERE tenant_id = $2 AND id = $3`, [pauseId, tenantId, row.sdr_id]);
        } else {
          await client.query(`UPDATE sdrs SET available = true, state = 'available', current_pause_id = NULL WHERE tenant_id = $1 AND id = $2`, [tenantId, row.sdr_id]);
        }
        if (!transientRateLimit) await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, row.number_id]);
      });
      if (resource) await this.redis.release({ tenantId: resource.tenantId, token: resource.token, numberId: resource.numberId, leadId: resource.leadId, sdrId: resource.sdrId });
      this.gateway.sendToSdr(row.sdr_id, { type: 'call_finished', callId, status: finalCallStatus, outcome, pause });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId: row.sdr_id, state: requiresPostCall ? 'post_call' : 'available', available: !requiresPostCall, pause }, tenantId);
    } finally {
      this.active.delete(callId);
      this.finishingCalls.delete(callId);
    }
  }
}
