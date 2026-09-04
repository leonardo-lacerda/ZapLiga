import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import WebSocket, { RawData } from 'ws';
import { DatabaseService } from '../../database/database.service';
import { legacyTenantId } from '../../database/tenant-context';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { WaxumClient } from '../../infrastructure/waxum/waxum.client';
import { normalizeWaxumStatus } from '../../infrastructure/waxum/waxum-status';
import { SdrGateway } from '../sdrs/sdr.gateway';
import { runtimeHeartbeatKey, runtimeInstanceId } from '../../infrastructure/runtime-instance';
import { Sentry } from '../../infrastructure/sentry/sentry';
import { ContactComplianceService } from '../contact-compliance/contact-compliance.service';
import { DialerScheduleService } from '../dialer-schedule/dialer-schedule.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { AuditService } from '../audit/audit.service';
import {
  analyzePcm16Le,
  computeCallOutcome,
  computeRateLimitBackoffSeconds,
  computeRateLimitCooldownWindowSeconds,
  isInboundAudioStalled,
  isInstantFailure,
  isSelfCallNumber,
  lineIsProtected,
  normalizePhone,
  shouldQuarantineLine,
} from './dialer.rules';

type CallResource = {
  tenantId: string;
  token: string;
  numberId: string;
  waxumSessionId: string;
  leadId: string;
  sdrId: string;
  media?: WebSocket;
  browser?: WebSocket;
  mediaActive: boolean;
  mediaOpen?: boolean;
  answerSignalReceived?: boolean;
  answerConfirmedAt?: number;
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
  rateLimitBackoffSeconds?: number;
  rapidFailureBackoffSeconds?: number;
  callPlacedAt?: number;
  receivedAnyFrame?: boolean;
  // VoIP recipient (`<lid>@lid`) and Waxum session, kept so we can send an
  // explicit `POST /calls/terminate` when the SDR hangs up.
  recipient?: string;
  // Diagnostic counters for the audio bridge, logged when the call finishes.
  inboundRelayed?: number;
  inboundDroppedPreAnswer?: number;
  micFramesRelayed?: number;
  inboundPcmSamples?: number;
  inboundPcmNonZeroSamples?: number;
  inboundPcmPeak?: number;
  postAnswerPcmSamples?: number;
  postAnswerPcmNonZeroSamples?: number;
  inboundAudioStallDetected?: boolean;
  micPcmSamples?: number;
  micPcmNonZeroSamples?: number;
  micPcmPeak?: number;
  browserPlayback?: {
    contextState?: string;
    outputSampleRate?: number;
    framesReceived?: number;
    framesScheduled?: number;
    framesEnded?: number;
    /** Frames the browser skipped to keep the playout backlog bounded (see AudioBridge). */
    framesDropped?: number;
    peak?: number;
    queuedSeconds?: number;
    /** The output endpoint the browser is actually playing on ('' = system default). */
    outputDevice?: string;
    /** How the sink was applied: 'context' (AudioContext.setSinkId), 'element' (<audio>.setSinkId) or 'default'. */
    sinkMode?: string;
    inputDevice?: string;
  };
  previousSdrAvailable: boolean;
  previousSdrState: string;
};

const safeOperationalError = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  .replace(/\b\d{10,15}\b/g, '[phone]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
  .replace(/([?&](?:token|ticket)=)[^&\s]+/gi, '$1[redacted]')
  .slice(0, 300);

// Every WhatsApp number owns exactly one Waxum session. Keep the session ID in
// the reservation key so a connection cannot be shared by two calls, even if
// two API requests somehow reference the same line concurrently.
const numberSessionId = (number: any) => String(number.waxum_session_id ?? number.id);
const numberRateConfig = (number: any) => ({
  maxCallsPerWindow: Math.max(1, Number(number.max_calls_per_window ?? 3) || 3),
  callWindowSeconds: Math.max(60, Number(number.call_window_seconds ?? 180) || 180),
});
const dialerPacingConfig = (settings: any) => ({
  maxCallsPerMinute: Math.max(1, Number(settings.max_calls_per_minute ?? 6) || 6),
  minSecondsBetweenCalls: Math.max(0, Number(settings.min_seconds_between_calls ?? 10) || 0),
});
// Manual calls are paced by the person clicking, not by the dialer: no
// per-line call window, no per-tenant calls-per-minute, no minimum gap. The
// window limits stay astronomically high rather than 0 so the reservation
// still RECORDS the call in the per-number window -- the automatic dialer
// must keep seeing the line's real volume when it paces its own calls.
const MANUAL_UNPACED = 1_000_000;
const manualPacingConfig = (number: any) => ({
  maxCallsPerWindow: MANUAL_UNPACED,
  callWindowSeconds: numberRateConfig(number).callWindowSeconds,
  maxCallsPerMinute: MANUAL_UNPACED,
  minSecondsBetweenCalls: 0,
});

@Injectable()
export class DialerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DialerService.name);
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly ticking = new Set<string>();
  private readonly lastStatusSyncAt = new Map<string, number>();
  private readonly lastCallbackNotificationAt = new Map<string, number>();
  private readonly active = new Map<string, CallResource>();
  private readonly finishingCalls = new Set<string>();
  private readonly logs: any[] = [];
  // Consecutive "instant failure" count per WhatsApp line (no media frames, no
  // answer, closed in <FLAG_FAST_FAIL_MS). Repeated instant failures are the
  // signature of a WhatsApp reachout timelock (463 MissingTcToken).
  private readonly FLAG_FAILURE_THRESHOLD = Math.max(2, Number(process.env.WHATSAPP_RAPID_FAILURE_THRESHOLD) || 2);
  private readonly FLAG_FAST_FAIL_MS = Math.max(3000, Number(process.env.WHATSAPP_RAPID_FAILURE_WINDOW_MS) || 5000);
  private readonly rapidFailureBackoffSeconds = Math.min(600, Math.max(180, Number(process.env.WHATSAPP_RAPID_FAILURE_BACKOFF_SECONDS) || 180));
  private readonly flagQuarantineHours = Math.max(1, Number(process.env.WHATSAPP_FLAG_HOURS) || 6);
  private readonly inboundAudioStallMs = Math.max(5000, Number(process.env.WHATSAPP_INBOUND_AUDIO_STALL_MS) || 10_000);
  private readonly inboundAudioStallSamples = Math.max(80_000, Number(process.env.WHATSAPP_INBOUND_AUDIO_STALL_SAMPLES) || 120_000);
  private readonly inboundAudioRecoveryBackoffSeconds = Math.min(600, Math.max(60, Number(process.env.WHATSAPP_INBOUND_AUDIO_RECOVERY_BACKOFF_SECONDS) || 90));

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly waxum: WaxumClient,
    @Inject(forwardRef(() => SdrGateway)) private readonly gateway: SdrGateway,
    @Optional() private readonly compliance?: ContactComplianceService,
    @Optional() private readonly schedule?: DialerScheduleService,
    @Optional() private readonly featureFlags?: FeatureFlagsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  onModuleInit() {
    void this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 10_000);
    this.timer = setInterval(() => void this.tickAllTenants(), 1000);
    void this.resetStaleSdrPresence()
      .then(() => this.recoverInterruptedCalls())
      .then(() => this.tickAllTenants())
      .catch((error) => {
        this.logger.error(`Dialer recovery failed: ${safeOperationalError(error)}`);
        Sentry.captureException(error);
      });
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await Promise.allSettled([...this.active.keys()].map((callId) => this.finishCall(callId, 'failed', 'api_restarted', false)));
    await this.redis.client.del(runtimeHeartbeatKey).catch(() => undefined);
    this.gateway.closeAll();
  }

  private heartbeat() { return this.redis.client.set(runtimeHeartbeatKey, runtimeInstanceId, 'EX', 30); }

  async getSettings(tenantId = legacyTenantId()) {
    await this.db.query('INSERT INTO dialer_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const result = await this.db.query('SELECT * FROM dialer_settings WHERE tenant_id = $1', [tenantId]);
    return result.rows[0];
  }

  async getLogs(tenantId = legacyTenantId()) {
    const shared = await this.redis.client.lrange(`zapcall:tenant:${tenantId}:dialer:logs`, 0, 99).catch(() => [] as string[]);
    if (shared.length) return shared.flatMap((entry) => { try { return [JSON.parse(entry)]; } catch { return []; } });
    return this.logs.filter((entry) => entry.tenantId === tenantId).slice(0, 100);
  }

  private normalizePhone(value: unknown) { return normalizePhone(value); }

  private relayAudio(socket: WebSocket | undefined, data: RawData) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // Audio is real-time data. Once the socket has a meaningful backlog, old
    // frames are less useful than keeping latency bounded. Dropping a frame
    // here prevents a slow browser/Waxum peer from growing memory without
    // bound under concurrency.
    if (socket.bufferedAmount > 256 * 1024) {
      this.logger.warn('Audio relay backpressure: frame descartado por buffer cheio');
      return false;
    }
    try { socket.send(data, { binary: true }); return true; } catch { return false; }
  }

  // Resolve the VoIP recipient for a phone. WhatsApp calls require the callee's
  // LID (not the phone-number JID) to derive media keys. Cold numbers have no
  // LID in the store, so we trigger a usync (`contacts/check`, silent for the
  // callee) to learn it, then read and cache it. The LID is a stable identity,
  // so caching it in Redis means we pay the usync cost once per number instead
  // of on every dial — which is what previously triggered the 429 storms.
  private async resolveRecipient(sessionId: string, phone: string): Promise<string> {
    if (phone.includes('@lid')) return phone;
    const pn = this.normalizePhone(phone);
    if (!pn) throw new Error('lid_unavailable');
    const cacheKey = `zapcall:lid:${pn}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) return `${cached}@lid`;
    const contact = await this.waxum.checkContact(sessionId, pn);
    if (!contact) throw new Error('lid_unavailable');
    if (!contact.isRegistered) throw new Error('not_on_whatsapp');
    let lid = await this.waxum.getStoredLid(sessionId, contact.jid);
    if (!lid) {
      // The usync that learns the LID can land just after check returns; retry
      // the store read once after a short delay before giving up.
      await new Promise((resolve) => setTimeout(resolve, 400));
      lid = await this.waxum.getStoredLid(sessionId, contact.jid);
    }
    if (!lid) throw new Error('lid_unavailable');
    await this.redis.client.set(cacheKey, lid, 'EX', 60 * 60 * 24 * 30).catch(() => undefined);
    return `${lid}@lid`;
  }

  async getSdrState(sdrId: string, tenantId = legacyTenantId()) {
    const result = await this.db.query(`
      SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
        p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
        c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
        c.connected_at AS pause_call_started_at,
        COALESCE(c.connected_duration_seconds, c.duration_seconds, 0)::int AS pause_call_duration_seconds,
        CASE WHEN p.started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - p.started_at))::int) END AS pause_elapsed_seconds
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
    if (available) {
      // A disponibilidade do SDR habilita a operação automática da empresa.
      // O tick ainda valida SDRs, números e pastas ativas antes de discar.
      const settings = await this.getSettings(tenantId);
      const withinSchedule = !this.schedule || (await this.schedule.evaluate(tenantId)).allowed;
      if (!settings.running && withinSchedule) {
        await this.db.query('UPDATE dialer_settings SET running = true WHERE tenant_id = $1', [tenantId]);
        this.log('Discador iniciado automaticamente por disponibilidade do SDR', 'info', undefined, tenantId);
      }
      if (withinSchedule) await this.tick(tenantId);
    }
    this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state, available }, tenantId);
    this.notifyOperationsChanged(tenantId, 'sdr_state_changed', { kind: 'sdr_state_changed', sdrId, state, available });
    return this.getSdrState(sdrId, tenantId);
  }

  async finishPause(sdrId: string, pauseId: string, input: { callResult?: string; pipelineStage?: string; notes?: string; continueAvailable?: boolean; callbackAt?: string; actorUserId?: string }, tenantId = legacyTenantId()) {
    if (input.callResult === 'retornar') await this.featureFlags?.assertEnabled(tenantId, 'callbacks');
    const callResult = String(input.callResult ?? '').trim();
    const pipelineStage = String(input.pipelineStage ?? '').trim();
    const notes = String(input.notes ?? '').trim();
    const continueAvailable = input.continueAvailable !== false;
    const stageByResult: Record<string, string> = {
      interessado: 'qualificado',
      sem_interesse: 'perdido',
      retornar: 'contatado',
      reuniao_agendada: 'reuniao',
      numero_invalido: 'perdido',
      nao_ligar_novamente: 'perdido',
    };
    if (!callResult || !pipelineStage) throw new Error('Resultado e etapa da tubulação são obrigatórios');
    if (continueAvailable && !this.gateway.isConnected(sdrId)) throw new Error('Conecte o canal do SDR antes de continuar disponível');
    if (!['sem_interesse', 'numero_invalido', 'nao_ligar_novamente'].includes(callResult) && !notes) throw new Error('Inclua uma anotação com o contexto e o próximo passo');
    if (stageByResult[callResult] && stageByResult[callResult] !== pipelineStage) throw new Error('A etapa selecionada não corresponde ao resultado da ligação');
    let callbackAt: Date | null = null;
    if (callResult === 'retornar') {
      callbackAt = new Date(String(input.callbackAt ?? ''));
      if (!Number.isFinite(callbackAt.getTime()) || callbackAt.getTime() <= Date.now()) throw new Error('Informe uma data futura para o retorno');
    }
    return this.db.transaction(async (client) => {
      const pauseResult = await client.query(`SELECT p.*, c.lead_id, l.name AS lead_name, l.phone AS lead_phone FROM sdr_pauses p LEFT JOIN calls c ON c.tenant_id = p.tenant_id AND c.id = p.call_id LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id WHERE p.tenant_id = $1 AND p.id = $2 AND p.sdr_id = $3 FOR UPDATE OF p`, [tenantId, pauseId, sdrId]);
      const pause = pauseResult.rows[0];
      if (!pause) throw new Error('Pausa não encontrada');
      if (pause.ended_at) throw new Error('Esta pausa já foi encerrada');
      const endedAt = new Date();
      let createdCallbackId: string | undefined;
      let completedCallbackIds: string[] = [];
      await client.query(`UPDATE sdr_pauses SET ended_at = $1, duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($1 - started_at))::int) WHERE tenant_id = $2 AND id = $3`, [endedAt, tenantId, pauseId]);
      if (pause.call_id) {
        await client.query(`UPDATE calls SET call_result = $1, pipeline_stage = $2, notes = $3, wrap_up_completed_at = $4 WHERE tenant_id = $5 AND id = $6`, [callResult, pipelineStage, notes, endedAt, tenantId, pause.call_id]);
        const previousStage = await client.query(`SELECT pipeline_stage, phone FROM leads WHERE tenant_id = $1 AND id = $2`, [tenantId, pause.lead_id]);
        await client.query(`UPDATE leads SET pipeline_stage = $1,
          status = CASE WHEN $4::timestamptz IS NULL THEN status ELSE 'retry_wait' END,
          next_eligible_at = COALESCE($4::timestamptz, next_eligible_at)
          WHERE tenant_id = $2 AND id = $3`, [pipelineStage, tenantId, pause.lead_id, callbackAt?.toISOString() ?? null]);
        const fromStage = previousStage.rows[0]?.pipeline_stage ?? null;
        if (fromStage !== pipelineStage) {
          await client.query(`INSERT INTO lead_stage_history (id, tenant_id, lead_id, from_stage, to_stage, source, call_id) VALUES ($1, $2, $3, $4, $5, 'wrap_up', $6)`, [randomUUID(), tenantId, pause.lead_id, fromStage, pipelineStage, pause.call_id]);
        }
        // Uma nova conversa encerra de forma idempotente qualquer retorno
        // anterior do lead. O retorno desta própria conversa é criado abaixo.
        const completedCallbacks = await client.query(`UPDATE lead_callbacks SET status = 'completed', completed_call_id = $1, completed_at = now(), updated_by_user_id = $2, updated_at = now()
          WHERE tenant_id = $3 AND lead_id = $4 AND origin_call_id IS DISTINCT FROM $1 AND status IN ('pending','due','reassigned') RETURNING id`, [pause.call_id, input.actorUserId ?? null, tenantId, pause.lead_id]);
        completedCallbackIds = completedCallbacks.rows.map((row: any) => row.id);
        if (callResult === 'retornar' && callbackAt) {
          const callback = await client.query(`INSERT INTO lead_callbacks (tenant_id, lead_id, origin_call_id, requested_by_sdr_id, assigned_sdr_id, due_at, notes, created_by_user_id, updated_by_user_id)
            VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$7)
            ON CONFLICT (tenant_id, lead_id) WHERE status IN ('pending','due','reassigned')
            DO UPDATE SET origin_call_id = EXCLUDED.origin_call_id, requested_by_sdr_id = EXCLUDED.requested_by_sdr_id,
              assigned_sdr_id = EXCLUDED.assigned_sdr_id, due_at = EXCLUDED.due_at, notes = EXCLUDED.notes,
              status = 'pending', updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now() RETURNING id`, [tenantId, pause.lead_id, pause.call_id, sdrId, callbackAt.toISOString(), notes, input.actorUserId ?? null]);
          createdCallbackId = callback.rows[0]?.id;
          await this.redis.incrementMetric?.('callbacks_created_total');
        }
        if (callResult === 'nao_ligar_novamente') {
          if (!this.compliance) throw new Error('Serviço de compliance indisponível');
          await this.compliance.suppressWithExecutor(client, {
            tenantId,
            phone: previousStage.rows[0]?.phone,
            reason: 'requested_opt_out',
            source: 'post_call',
            notes,
            actorUserId: input.actorUserId,
          });
        }
      }
      const nextState = continueAvailable ? 'available' : 'offline';
      await client.query(`UPDATE sdrs SET available = $4, state = $5, current_pause_id = NULL WHERE tenant_id = $1 AND id = $2 AND current_pause_id = $3`, [tenantId, sdrId, pauseId, continueAvailable, nextState]);
      return { id: pauseId, ended_at: endedAt.toISOString(), duration_seconds: Math.max(0, Math.floor((endedAt.getTime() - new Date(pause.started_at).getTime()) / 1000)), call_result: callResult, pipeline_stage: pipelineStage, notes, lead_name: pause.lead_name, callback_at: callbackAt?.toISOString() ?? null, callback_created_id: createdCallbackId, callbacks_completed: completedCallbackIds, available: continueAvailable, state: nextState };
    }).then(async (result) => {
      if (this.audit && result.callback_created_id) await this.audit.record({ actorUserId: input.actorUserId, tenantId, action: 'callback.created', entityType: 'callback', entityId: result.callback_created_id }).catch(() => undefined);
      if (this.audit) for (const callbackId of result.callbacks_completed) await this.audit.record({ actorUserId: input.actorUserId, tenantId, action: 'callback.completed', entityType: 'callback', entityId: callbackId }).catch(() => undefined);
      this.gateway.sendToSdr(sdrId, { type: 'pause_finished', pauseId, state: result.state, available: result.available });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state: result.state, available: result.available }, tenantId);
      this.notifyOperationsChanged(tenantId, result.callback_created_id ? 'lead_rescheduled' : 'pause_finished', {
        kind: result.callback_created_id ? 'lead_rescheduled' : 'pause_finished',
        sdrId,
        leadName: result.lead_name,
        callbackAt: result.callback_at,
        state: result.state,
        available: result.available,
      });
      return result;
    });
  }

  private notifyOperationsChanged(tenantId: string, reason: string, activity?: Record<string, unknown>) {
    this.gateway.broadcastToOperations?.({ type: 'operations_changed', reason, at: new Date().toISOString(), activity }, tenantId);
  }

  private log(message: string, level: 'info' | 'warning' | 'error' = 'info', callId?: string, tenantId = legacyTenantId()) {
    const entry = { id: randomUUID(), at: new Date().toISOString(), level, message, callId, tenantId };
    this.logs.unshift(entry);
    if (this.logs.length > 100) this.logs.pop();
    void this.redis.client.lpush(`zapcall:tenant:${tenantId}:dialer:logs`, JSON.stringify(entry))
      .then(() => this.redis.client.ltrim(`zapcall:tenant:${tenantId}:dialer:logs`, 0, 99))
      .catch(() => undefined);
    this.gateway.broadcast({ type: 'dialer_log', log: entry }, tenantId);
  }

  async updateSettings(input: Record<string, unknown>, tenantId = legacyTenantId()) {
    const allowed = [
      'global_max_concurrent_calls', 'max_calls_per_minute', 'min_seconds_between_calls', 'max_attempts_per_lead', 'retry_delay_minutes',
      'ring_timeout_seconds', 'default_number_cooldown_seconds', 'queue_strategy',
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
    if (this.schedule) await this.schedule.assertAllowed(tenantId);
    await this.db.query('UPDATE dialer_settings SET running = true WHERE tenant_id = $1', [tenantId]);
    this.log('Discador iniciado', 'info', undefined, tenantId);
    this.notifyOperationsChanged(tenantId, 'dialer_status_changed', { kind: 'dialer_status_changed', running: true });
    await this.tick(tenantId);
    return this.getStatus(tenantId);
  }

  async pause(tenantId = legacyTenantId()) {
    await this.db.query('UPDATE dialer_settings SET running = false WHERE tenant_id = $1', [tenantId]);
    this.log('Discador pausado', 'info', undefined, tenantId);
    this.notifyOperationsChanged(tenantId, 'dialer_status_changed', { kind: 'dialer_status_changed', running: false });
    return this.getStatus(tenantId);
  }

  private async defaultFolderId(tenantId: string) {
    const result = await this.db.query(`SELECT id FROM lead_folders WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC LIMIT 1`, [tenantId]);
    if (!result.rows[0]) throw new Error('Nenhuma pasta de leads foi configurada');
    return result.rows[0].id as string;
  }

  async manualCall(leadId: string, tenantId = legacyTenantId()) {
    if (this.schedule) await this.schedule.assertAllowed(tenantId);
    const settings = await this.getSettings(tenantId);
    const [sdrs, numbers, leads] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.tenant_id = $1 AND s.state NOT IN ('in_call', 'post_call')
          AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active')
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `, [tenantId]),
      // Manual calls keep the line PROTECTIONS (quarantine after instant
      // failures, Waxum 429 backoff -- both future-date last_call_ended_at) but
      // not the automatic dialer's pacing: a person may dial again right away.
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
      this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.id = $2 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $3`, [tenantId, leadId, settings.max_attempts_per_lead]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    const lead = leads.rows[0];
    if (!lead) throw new Error('Este lead não está elegível para uma chamada manual');
    if (!sdr) throw new Error('Nenhum SDR conectado e disponível');
    if (!numbers.rows.length) throw new Error('Nenhum número WhatsApp conectado');
    const readyNumbers = numbers.rows.filter((row: any) => !lineIsProtected(row.last_call_ended_at));
    if (!readyNumbers.length) throw new Error('A linha WhatsApp está temporariamente protegida por limite de chamadas. Aguarde alguns minutos e tente novamente.');
    const number = readyNumbers.find((row: any) => !isSelfCallNumber(row.phone, lead.phone));
    if (!number) throw new Error('O número de destino é a própria linha de WhatsApp conectada. Ligue para um número diferente.');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      tenantId, token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id, waxumSessionId: numberSessionId(number),
      ...manualPacingConfig(number),
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estão ocupados; tente novamente em instantes');
    return this.startReservedCall(sdr, number, lead, settings, token, 'manual', tenantId);
  }

  async manualCallWithInput(input: { leadId?: string; phone?: string; name?: string }, tenantId = legacyTenantId(), sdrUserId?: string) {
    if (this.schedule) await this.schedule.assertAllowed(tenantId);
    const settings = await this.getSettings(tenantId);
    let lead: any;
    const leadId = String(input.leadId ?? '').trim();
    if (leadId) {
      const result = await this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.id = $2 AND l.do_not_call = false AND NOT EXISTS (SELECT 1 FROM contact_suppressions cs WHERE cs.tenant_id = l.tenant_id AND cs.phone = l.phone AND cs.lifted_at IS NULL)`, [tenantId, leadId]);
      lead = result.rows[0];
      if (lead) {
        const activeCall = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, lead.id]);
        if (activeCall.rows[0]) lead = undefined;
      }
    } else {
      const phone = String(input.phone ?? '').replace(/\D/g, '');
      if (phone.length < 10 || phone.length > 15) throw new Error('Informe um telefone valido com DDD');
      const suppressed = await this.db.query(`SELECT 1 FROM contact_suppressions WHERE tenant_id = $1 AND phone = $2 AND lifted_at IS NULL LIMIT 1`, [tenantId, phone]);
      if (suppressed.rows[0]) { await this.redis.incrementMetric?.('calls_blocked_suppression_total'); await this.audit?.record({ tenantId, action: 'call.blocked_suppression', entityType: 'contact' }).catch(() => undefined); throw new Error('Este telefone está na lista de não contato'); }
      const existing = await this.db.query(`SELECT l.* FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND l.phone = $2 LIMIT 1`, [tenantId, phone]);
      if (existing.rows[0]) {
        lead = existing.rows[0];
        const activeCall = await this.db.query(`SELECT 1 FROM calls WHERE tenant_id = $1 AND lead_id = $2 AND status IN ('reserved', 'dialing', 'media_active') LIMIT 1`, [tenantId, lead.id]);
        // A manual call is an explicit override of queue eligibility. It may
        // redial a previously completed/failed lead, but never a blocked lead
        // or one that already has an active call.
        if (lead.do_not_call || activeCall.rows[0]) lead = undefined;
      } else {
        lead = await this.db.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead-quota:${tenantId}`]);
          const [tenant, count] = await Promise.all([
            client.query('SELECT max_leads FROM tenants WHERE id = $1', [tenantId]),
            client.query('SELECT count(*)::int AS count FROM leads WHERE tenant_id = $1', [tenantId]),
          ]);
          if (Number(count.rows[0]?.count ?? 0) >= Number(tenant.rows[0]?.max_leads ?? 100000)) throw new Error('O limite de leads desta empresa foi atingido');
          const folderId = await this.defaultFolderId(tenantId);
          return (await client.query("INSERT INTO leads (id, tenant_id, folder_id, name, phone, status) VALUES ($1, $2, $3, $4, $5, 'manual') RETURNING *", [randomUUID(), tenantId, folderId, String(input.name ?? '').trim() || 'Ligacao manual', phone])).rows[0];
        });
      }
    }
    if (!lead) throw new Error('Este contato nao esta elegivel para uma chamada manual');

    const [sdrs, numbers] = await Promise.all([
      this.db.query(`
        SELECT s.* FROM sdrs s
        WHERE s.tenant_id = $1 AND s.state NOT IN ('in_call', 'post_call')
          AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active')
          AND ($2::text IS NULL OR s.user_id = $2)
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
        ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
      `, [tenantId, sdrUserId ?? null]),
      this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
    ]);
    const sdr = sdrs.rows.find((row: any) => this.gateway.isConnected(row.id));
    if (!sdr) throw new Error('Nenhum SDR conectado e disponivel');
    if (!numbers.rows.length) throw new Error('Nenhum numero WhatsApp conectado');
    // Protections only (see manualCall): a manual call is not paced by the cooldown.
    const readyNumbers = numbers.rows.filter((row: any) => !lineIsProtected(row.last_call_ended_at));
    if (!readyNumbers.length) throw new Error('A linha WhatsApp esta temporariamente protegida por limite de chamadas. Aguarde alguns minutos e tente novamente.');
    // WhatsApp cannot place a call to the line's own number (self-call closes
    // the media socket immediately), so never pair a lead with its own line.
    const number = readyNumbers.find((row: any) => !isSelfCallNumber(row.phone, lead.phone));
    if (!number) throw new Error('O numero de destino e a propria linha de WhatsApp conectada. Ligue para um numero diferente.');

    const token = randomUUID();
    const reserved = await this.redis.reserve({
      tenantId, token, globalMax: settings.global_max_concurrent_calls,
      numberMax: number.max_concurrent_calls, numberId: number.id, waxumSessionId: numberSessionId(number),
      ...manualPacingConfig(number),
      leadId: lead.id, sdrId: sdr.id,
      ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
    });
    if (!reserved) throw new Error('Os limites de chamadas estao ocupados; tente novamente em instantes');
    return { ...(await this.startReservedCall(sdr, number, lead, settings, token, 'manual', tenantId)), leadId: lead.id };
  }

  async getStatus(tenantId = legacyTenantId(), from?: string, to?: string) {
    const cacheKey = `zapcall:tenant:${tenantId}:dashboard:${from ?? ''}:${to ?? ''}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) { try { return JSON.parse(cached); } catch { /* recompute corrupt cache */ } }
    const result = await this.getStatusFresh(tenantId, from, to);
    await this.redis.client.set(cacheKey, JSON.stringify(result), 'PX', Math.max(250, Number(process.env.DASHBOARD_CACHE_TTL_MS ?? 1500) || 1500)).catch(() => undefined);
    return result;
  }

  async getOperationsSnapshot(tenantId = legacyTenantId()) {
    const [status, today] = await Promise.all([
      this.getStatus(tenantId),
      this.db.query(`
        SELECT COUNT(*)::int AS attempts_today,
          COUNT(DISTINCT c.lead_id) FILTER (WHERE c.connected_at IS NOT NULL)::int AS leads_attended_today
        FROM calls c
        JOIN tenants t ON t.id = c.tenant_id
        WHERE c.tenant_id = $1
          AND c.created_at >= date_trunc('day', now() AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'UTC')) AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'UTC')
          AND c.created_at < (date_trunc('day', now() AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'UTC')) + interval '1 day') AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'UTC')
      `, [tenantId]),
    ]);
    const row = today.rows[0] ?? {};
    return {
      ...status,
      generated_at: new Date().toISOString(),
      attempts_today: Number(row.attempts_today ?? 0),
      leads_attended_today: Number(row.leads_attended_today ?? 0),
      simultaneous_limit: Number(status.settings?.global_max_concurrent_calls ?? 0),
    };
  }

  private async getStatusFresh(tenantId = legacyTenantId(), from?: string, to?: string) {
    const settings = await this.getSettings(tenantId);
    const scheduleState = this.schedule ? await this.schedule.evaluate(tenantId, new Date(), true) : { allowed: true, reason: 'schedule_service_unavailable' };
    const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : new Date().toISOString();
    const startDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const start = startDate.toISOString();
    const counts = await this.db.query(`
      SELECT status, count(*)::int AS count FROM calls
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 GROUP BY status
    `, [tenantId, start, end]);
    const answered = await this.db.query(`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered
      FROM calls WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
    `, [tenantId, start, end]);
    const [available, leads, numberDetails, queueSummary, queuePreview, activeCalls, sdrDetails, folderSummary] = await Promise.all([
      this.db.query(`
        SELECT count(*)::int AS count FROM sdrs s
        WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
          )
      `, [tenantId]),
      this.db.query(`SELECT l.status, count(*)::int AS count FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id WHERE l.tenant_id = $1 AND f.is_active = true GROUP BY l.status`, [tenantId]),
      this.db.query(`
        SELECT n.id, n.label, n.status, n.max_concurrent_calls, n.cooldown_seconds,
          n.max_calls_per_window, n.call_window_seconds,
          n.last_call_ended_at, n.flagged_until,
          (n.flagged_until IS NOT NULL AND n.flagged_until > now()) AS flagged,
          CASE WHEN n.flagged_until IS NULL OR n.flagged_until <= now() THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (n.flagged_until - now())))::int)
          END AS flagged_remaining_seconds,
          COUNT(c.id)::int AS active_calls,
          CASE WHEN n.last_call_ended_at IS NULL THEN 0
            ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM ((n.last_call_ended_at + n.cooldown_seconds * interval '1 second') - now())))::int)
          END AS cooldown_remaining_seconds
        FROM whatsapp_numbers n
        LEFT JOIN calls c ON c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')
        WHERE n.tenant_id = $1 AND n.status <> 'removed'
        GROUP BY n.id
        ORDER BY n.created_at DESC
      `, [tenantId]),
      this.db.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE next_eligible_at <= now())::int AS ready,
          COUNT(*) FILTER (WHERE next_eligible_at > now())::int AS waiting
        FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
        WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
          AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT l.id, l.name, l.phone, l.status, l.attempts, l.next_eligible_at, f.name AS folder_name,
          ROW_NUMBER() OVER (ORDER BY l.next_eligible_at ASC, l.created_at ASC)::int AS queue_position
        FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
        WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
          AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
        ORDER BY l.next_eligible_at ASC, l.created_at ASC
        LIMIT 12
      `, [tenantId, settings.max_attempts_per_lead]),
      this.db.query(`
        SELECT c.id, c.sdr_id, c.lead_id, c.number_id, c.status, c.attempt_number, c.source, c.created_at, c.started_at, c.connected_at,
          GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(c.connected_at, c.started_at, c.created_at)))::int) AS elapsed_seconds,
          l.name AS lead_name, l.phone AS lead_phone, n.label AS number_label, s.name AS sdr_name
        FROM calls c
        JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        JOIN whatsapp_numbers n ON n.id = c.number_id
        JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id
        WHERE c.tenant_id = $1 AND c.status IN ('reserved', 'dialing', 'media_active')
        ORDER BY c.created_at ASC
      `, [tenantId]),
      this.db.query(`
        SELECT s.id, s.name, s.available, s.state, s.current_pause_id,
          p.pause_type, p.started_at AS pause_started_at, p.call_id AS pause_call_id,
          c.lead_id AS pause_lead_id, l.name AS pause_lead_name, l.phone AS pause_lead_phone,
          c.connected_at AS pause_call_started_at,
          CASE WHEN p.started_at IS NULL THEN 0 ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - p.started_at))::int) END AS pause_elapsed_seconds,
          active_call.id AS active_call_id, active_call.status AS active_call_status,
          active_call.started_at AS active_call_started_at, active_call.connected_at AS active_call_connected_at,
          GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(active_call.connected_at, active_call.started_at, active_call.created_at)))::int) AS active_call_elapsed_seconds,
          active_lead.id AS active_lead_id, active_lead.name AS active_lead_name, active_lead.phone AS active_lead_phone,
          active_number.id AS active_number_id, active_number.label AS active_number_label
        FROM sdrs s
        LEFT JOIN sdr_pauses p ON p.tenant_id = s.tenant_id AND p.id = s.current_pause_id AND p.ended_at IS NULL
        LEFT JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = p.call_id
        LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        LEFT JOIN calls active_call ON active_call.tenant_id = s.tenant_id AND active_call.sdr_id = s.id AND active_call.status IN ('reserved', 'dialing', 'media_active')
        LEFT JOIN leads active_lead ON active_lead.tenant_id = active_call.tenant_id AND active_lead.id = active_call.lead_id
        LEFT JOIN whatsapp_numbers active_number ON active_number.id = active_call.number_id
        WHERE s.tenant_id = $1
        ORDER BY s.name
      `, [tenantId]),
      this.db.query(`
        SELECT f.id AS folder_id, f.name, f.is_active,
          COUNT(l.id)::int AS lead_count,
          COUNT(l.id) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < ds.max_attempts_per_lead AND l.next_eligible_at <= now() AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned')))::int AS ready_count,
          COUNT(l.id) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued', 'retry_wait') AND l.attempts < ds.max_attempts_per_lead AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned')))::int AS queue_count
        FROM lead_folders f
        LEFT JOIN dialer_settings ds ON ds.tenant_id = f.tenant_id
        LEFT JOIN leads l ON l.tenant_id = f.tenant_id AND l.folder_id = f.id
        WHERE f.tenant_id = $1
        GROUP BY f.id, f.name, f.is_active, ds.max_attempts_per_lead, f.sort_order, f.created_at
        ORDER BY f.sort_order ASC, f.created_at ASC
      `, [tenantId]),
    ]);
    const queue = queueSummary.rows[0] ?? { total: 0, ready: 0, waiting: 0 };
    const nextLead = queuePreview.rows[0] ?? null;
    const connectedNumbers = numberDetails.rows.filter((row: any) => ['connected', 'online', 'ready', 'authenticated'].includes(String(row.status).toLowerCase()));
    const dialableNumbers = connectedNumbers.filter((row: any) => !row.flagged);
    const readyNumbers = dialableNumbers.filter((row: any) => Number(row.cooldown_remaining_seconds) === 0);
    const activeFolders = folderSummary.rows.filter((row: any) => row.is_active);
    let nextAction = 'Pronto para discar';
    if (!settings.running) nextAction = 'Discador pausado';
    else if (!scheduleState.allowed) nextAction = 'Fora do horário de operação';
    else if (!activeFolders.length) nextAction = 'Nenhuma pasta ativa';
    else if (!Number(queue.total)) nextAction = 'Fila vazia';
    else if (!Number(available.rows[0].count)) nextAction = 'Aguardando SDR disponível';
    else if (!connectedNumbers.length) nextAction = 'Aguardando número WhatsApp conectado';
    else if (!dialableNumbers.length) nextAction = 'Linhas pausadas pelo limite do WhatsApp';
    else if (!readyNumbers.length) nextAction = 'Aguardando cooldown dos números';
    else if (!Number(queue.ready)) nextAction = 'Aguardando horário da próxima tentativa';
    return {
      running: settings.running,
      settings,
      schedule: scheduleState,
      // Read this from Postgres so the dashboard remains correct if work is
      // ever handled by more than one API process.
      active_calls: activeCalls.rows.length,
      available_sdrs: available.rows[0].count,
      call_counts: Object.fromEntries(counts.rows.map((row: any) => [row.status, row.count])),
      answered: answered.rows[0].answered,
      answer_rate: answered.rows[0].total ? Math.round((answered.rows[0].answered / answered.rows[0].total) * 100) : 0,
      lead_counts: Object.fromEntries(leads.rows.map((row: any) => [row.status, row.count])),
      sdrs: sdrDetails.rows,
      post_call_sdrs: sdrDetails.rows.filter((row: any) => row.state === 'post_call'),
      queue: { total: Number(queue.total), ready: Number(queue.ready), waiting: Number(queue.waiting), preview: queuePreview.rows },
      numbers: numberDetails.rows,
      active_calls_detail: activeCalls.rows,
      next_action: nextAction,
      next_lead: nextLead,
      active_folder_count: activeFolders.length,
      active_folder_ids: activeFolders.map((row: any) => row.folder_id),
      queued_leads_active_folders: Number(queue.total),
      folder_queue_summary: folderSummary.rows,
    };
  }

  async getSdrStatus(tenantId: string, userId: string) {
    const [settings, ownSdr, pool, scheduleState] = await Promise.all([
      this.getSettings(tenantId),
      this.db.query(`SELECT id FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [tenantId, userId]),
      // Per-tenant lines: expose only whether a line is available, never how many.
      this.db.query(`SELECT EXISTS (SELECT 1 FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now())) AS ready`, [tenantId]),
      this.schedule ? this.schedule.evaluate(tenantId, new Date(), true) : Promise.resolve({ allowed: true, reason: 'schedule_service_unavailable' }),
    ]);
    const sdr = ownSdr.rows[0] ? await this.getSdrState(ownSdr.rows[0].id, tenantId) : null;
    const [queueResult, personalResult, callbackResult] = await Promise.all([
      this.db.query(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE l.next_eligible_at <= now())::int AS ready,
          COUNT(*) FILTER (WHERE l.next_eligible_at > now())::int AS waiting
        FROM leads l
        JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
        WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false
          AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
          AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
      `, [tenantId, settings.max_attempts_per_lead]),
      sdr ? this.db.query(`
        SELECT COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE connected_at IS NOT NULL)::int AS answered,
          COALESCE(SUM(connected_duration_seconds), 0)::int AS conversation_seconds,
          COALESCE(SUM(EXTRACT(EPOCH FROM (sp.ended_at - sp.started_at))) FILTER (WHERE sp.ended_at IS NOT NULL), 0)::int AS wrap_up_seconds
        FROM calls c
        LEFT JOIN sdr_pauses sp ON sp.tenant_id = c.tenant_id AND sp.call_id = c.id
        WHERE c.tenant_id = $1 AND c.sdr_id = $2 AND c.created_at >= now() - interval '24 hours'
      `, [tenantId, sdr.id]) : Promise.resolve({ rows: [{ calls: 0, answered: 0, conversation_seconds: 0, wrap_up_seconds: 0 }] }),
      sdr ? this.db.query(`SELECT cb.id, cb.lead_id, cb.due_at, cb.status, cb.notes, l.name AS lead_name, l.phone AS lead_phone,
        (cb.due_at <= now()) AS overdue FROM lead_callbacks cb JOIN leads l ON l.tenant_id = cb.tenant_id AND l.id = cb.lead_id
        WHERE cb.tenant_id = $1 AND cb.assigned_sdr_id = $2 AND cb.status IN ('pending','due','reassigned') ORDER BY cb.due_at ASC LIMIT 8`, [tenantId, sdr.id]) : Promise.resolve({ rows: [] }),
    ]);
    const queue = queueResult.rows[0] ?? { total: 0, ready: 0, waiting: 0 };
    const personal = personalResult.rows[0] ?? { calls: 0, answered: 0, conversation_seconds: 0, wrap_up_seconds: 0 };
    const lineReady = Boolean(pool.rows[0]?.ready);
    let nextAction = 'Conecte seu painel para iniciar';
    if (sdr?.current_pause_id) nextAction = 'Finalize o pós-atendimento';
    else if (!scheduleState.allowed) nextAction = 'Fora do horário de operação';
    else if (!lineReady) nextAction = 'Aguardando uma linha do WhatsApp';
    else if (!settings.running) nextAction = 'Operação pausada pelo gestor';
    else if (!Number(queue.total)) nextAction = 'Fila sem contatos no momento';
    else if (!Number(queue.ready)) nextAction = 'Aguardando o horário da próxima tentativa';
    else if (!sdr?.available) nextAction = 'Fique disponível para receber chamadas';
    else nextAction = 'Aguardando uma conversa da fila';
    return {
      running: Boolean(settings.running),
      schedule: scheduleState,
      sdr,
      line_ready: lineReady,
      queue: { total: Number(queue.total), ready: Number(queue.ready), waiting: Number(queue.waiting) },
      personal: {
        calls: Number(personal.calls), answered: Number(personal.answered),
        conversation_seconds: Number(personal.conversation_seconds), wrap_up_seconds: Number(personal.wrap_up_seconds),
      },
      callbacks: callbackResult.rows,
      overdue_callbacks: callbackResult.rows.filter((item: any) => item.overdue).length,
      next_action: nextAction,
    };
  }

  async getSdrMetrics(tenantId: string, userId: string, from?: string, to?: string) {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date();
    const endDate = to && datePattern.test(to) ? new Date(`${to}T23:59:59.999Z`) : today;
    const defaultStart = new Date(endDate.getTime() - 29 * 24 * 60 * 60 * 1000);
    let startDate = from && datePattern.test(from) ? new Date(`${from}T00:00:00.000Z`) : defaultStart;
    if (!Number.isFinite(startDate.getTime()) || startDate > endDate) startDate = defaultStart;
    // Keep personal analytics bounded even if somebody edits the query string.
    if (endDate.getTime() - startDate.getTime() > 366 * 24 * 60 * 60 * 1000) {
      startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
    }
    const start = startDate.toISOString();
    const end = endDate.toISOString();
    const ownSdr = await this.db.query(`SELECT id, name FROM sdrs WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`, [tenantId, userId]);
    const sdr = ownSdr.rows[0];
    const emptySummary = { calls: 0, answered: 0, answer_rate: 0, conversation_seconds: 0, average_conversation_seconds: 0, wrap_up_seconds: 0, average_wrap_up_seconds: 0, positive: 0, meetings: 0 };
    if (!sdr) return { period: { from: start.slice(0, 10), to: end.slice(0, 10) }, sdr: null, summary: emptySummary, outcomes: [], trend: [], recent: [] };

    const [summaryResult, outcomesResult, trendResult, recentResult] = await Promise.all([
      this.db.query(`
        SELECT COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE c.connected_at IS NOT NULL)::int AS answered,
          COALESCE(SUM(c.connected_duration_seconds) FILTER (WHERE c.connected_at IS NOT NULL), 0)::int AS conversation_seconds,
          COALESCE(SUM(wrap.seconds), 0)::int AS wrap_up_seconds,
          COUNT(*) FILTER (WHERE c.call_result IN ('interessado', 'reuniao_agendada'))::int AS positive,
          COUNT(*) FILTER (WHERE c.call_result = 'reuniao_agendada')::int AS meetings
        FROM calls c
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(COALESCE(sp.duration_seconds, GREATEST(0, EXTRACT(EPOCH FROM (sp.ended_at - sp.started_at))::int))), 0)::int AS seconds
          FROM sdr_pauses sp WHERE sp.tenant_id = c.tenant_id AND sp.call_id = c.id AND sp.ended_at IS NOT NULL
        ) wrap ON true
        WHERE c.tenant_id = $1 AND c.sdr_id = $2 AND c.created_at >= $3 AND c.created_at <= $4
      `, [tenantId, sdr.id, start, end]),
      this.db.query(`
        SELECT c.call_result AS code, COUNT(*)::int AS count
        FROM calls c
        WHERE c.tenant_id = $1 AND c.sdr_id = $2 AND c.created_at >= $3 AND c.created_at <= $4
          AND c.call_result IS NOT NULL
        GROUP BY c.call_result ORDER BY count DESC, code ASC
      `, [tenantId, sdr.id, start, end]),
      this.db.query(`
        SELECT to_char(c.created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE c.connected_at IS NOT NULL)::int AS answered,
          COALESCE(SUM(c.connected_duration_seconds) FILTER (WHERE c.connected_at IS NOT NULL), 0)::int AS conversation_seconds
        FROM calls c
        WHERE c.tenant_id = $1 AND c.sdr_id = $2 AND c.created_at >= $3 AND c.created_at <= $4
        GROUP BY day ORDER BY day ASC
      `, [tenantId, sdr.id, start, end]),
      this.db.query(`
        SELECT c.id, c.created_at, c.connected_at, c.ended_at, c.status, c.call_result, c.pipeline_stage,
          COALESCE(c.connected_duration_seconds, 0)::int AS conversation_seconds,
          l.name AS lead_name, l.phone AS lead_phone
        FROM calls c
        LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
        WHERE c.tenant_id = $1 AND c.sdr_id = $2 AND c.created_at >= $3 AND c.created_at <= $4
        ORDER BY c.created_at DESC LIMIT 10
      `, [tenantId, sdr.id, start, end]),
    ]);
    const row = summaryResult.rows[0] ?? emptySummary;
    const calls = Number(row.calls) || 0;
    const answered = Number(row.answered) || 0;
    const conversationSeconds = Number(row.conversation_seconds) || 0;
    const wrapUpSeconds = Number(row.wrap_up_seconds) || 0;
    return {
      period: { from: start.slice(0, 10), to: end.slice(0, 10) },
      sdr: { id: sdr.id, name: sdr.name },
      summary: {
        calls, answered, answer_rate: calls ? Math.round((answered / calls) * 100) : 0,
        conversation_seconds: conversationSeconds,
        average_conversation_seconds: answered ? Math.round(conversationSeconds / answered) : 0,
        wrap_up_seconds: wrapUpSeconds,
        average_wrap_up_seconds: answered ? Math.round(wrapUpSeconds / answered) : 0,
        positive: Number(row.positive) || 0, meetings: Number(row.meetings) || 0,
      },
      outcomes: outcomesResult.rows.map((item: any) => ({ code: item.code, count: Number(item.count) || 0 })),
      trend: trendResult.rows.map((item: any) => ({ day: item.day, calls: Number(item.calls) || 0, answered: Number(item.answered) || 0, conversation_seconds: Number(item.conversation_seconds) || 0 })),
      recent: recentResult.rows,
    };
  }

  async tick(tenantId = legacyTenantId()) {
    const tickToken = randomUUID();
    // Reservations are globally atomic in Redis, so independent API
    // instances can process their locally-connected SDRs without one
    // instance blocking another instance's WebSocket connections.
    const tickLock = `zapcall:tenant:${tenantId}:lock:dialer-tick:${runtimeInstanceId}`;
    if (!await this.redis.acquireLock(tickLock, tickToken, 30_000)) return;
    if (this.ticking.has(tenantId)) { await this.redis.releaseLock(tickLock, tickToken); return; }
    this.ticking.add(tenantId);
    try {
      await this.expireReservations(tenantId);
      if (Date.now() - (this.lastCallbackNotificationAt.get(tenantId) ?? 0) >= 30_000) {
        this.lastCallbackNotificationAt.set(tenantId, Date.now());
        const dueTransition = await this.db.query(`UPDATE lead_callbacks SET status = 'due', updated_at = now() WHERE tenant_id = $1 AND status IN ('pending','reassigned') AND due_at <= now() RETURNING id`, [tenantId]);
        for (const callback of dueTransition?.rows ?? []) await this.audit?.record({ tenantId, action: 'callback.due', entityType: 'callback', entityId: callback.id }).catch(() => undefined);
        const dueCallbacks = await this.db.query(`SELECT cb.id, cb.assigned_sdr_id, cb.due_at, l.name AS lead_name, l.phone AS lead_phone
          FROM lead_callbacks cb JOIN leads l ON l.tenant_id = cb.tenant_id AND l.id = cb.lead_id
          WHERE cb.tenant_id = $1 AND cb.assigned_sdr_id IS NOT NULL AND cb.status = 'due' AND cb.due_at <= now()`, [tenantId]);
        for (const callback of dueCallbacks.rows) if (this.gateway.isConnected(callback.assigned_sdr_id)) this.gateway.sendToSdr(callback.assigned_sdr_id, { type: 'callback_due', callback });
      }
      const lastStatusSyncAt = this.lastStatusSyncAt.get(tenantId) ?? 0;
      if (Date.now() - lastStatusSyncAt >= 15000) {
        const syncToken = randomUUID();
        const syncLock = `zapcall:tenant:${tenantId}:lock:number-status-sync`;
        if (await this.redis.acquireLock(syncLock, syncToken, 15000)) {
          this.lastStatusSyncAt.set(tenantId, Date.now());
          try { await this.syncNumberStatuses(tenantId); }
          finally { await this.redis.releaseLock(syncLock, syncToken); }
        }
      }
      const settings = await this.getSettings(tenantId);
      if (!settings?.running) return;
      if (this.schedule && !(await this.schedule.evaluate(tenantId)).allowed) return;
      const [sdrs, numbers, leads, activeFolderCount] = await Promise.all([
        this.db.query(`
            SELECT s.* FROM sdrs s
            WHERE s.tenant_id = $1 AND s.available = true AND s.state = 'available'
              AND EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.role = 'sdr' AND tm.status = 'active')
            AND NOT EXISTS (
              SELECT 1 FROM calls c
                WHERE c.tenant_id = s.tenant_id AND c.sdr_id = s.id AND c.status IN ('reserved', 'dialing', 'media_active')
            )
          ORDER BY s.last_assigned_at NULLS FIRST, s.last_assigned_at ASC
        `, [tenantId]),
        this.db.query(`SELECT * FROM whatsapp_numbers WHERE tenant_id = $1 AND status IN ('connected', 'online', 'ready', 'authenticated') AND (flagged_until IS NULL OR flagged_until <= now()) AND (last_call_ended_at IS NULL OR last_call_ended_at <= now() - (cooldown_seconds * interval '1 second')) ORDER BY last_call_ended_at NULLS FIRST, last_call_ended_at ASC`, [tenantId]),
          this.db.query(`
          WITH active_folders AS (
            SELECT f.id, (ROW_NUMBER() OVER (ORDER BY f.sort_order ASC, f.created_at ASC) - 1)::int AS folder_index,
              COUNT(*) OVER ()::int AS folder_count
            FROM lead_folders f
            WHERE f.tenant_id = $1 AND f.is_active = true
          ), eligible AS (
            SELECT l.*, f.name AS folder_name, f.sort_order AS folder_sort_order,
              af.folder_index, af.folder_count,
              ROW_NUMBER() OVER (PARTITION BY l.folder_id
                ORDER BY CASE WHEN $5 = 'priority_fifo' THEN l.queue_priority ELSE 0 END DESC,
                  l.next_eligible_at ASC,
                  CASE WHEN $5 = 'lifo' THEN -l.queue_sequence ELSE l.queue_sequence END ASC)::int AS folder_rank
            FROM leads l
            JOIN active_folders af ON af.id = l.folder_id
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
              AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
              AND l.last_auto_round < $3 AND l.next_eligible_at <= now()
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          )
          SELECT * FROM eligible
          ORDER BY ((folder_index - ($4 % folder_count) + folder_count) % folder_count) ASC,
            folder_rank ASC,
            CASE WHEN $5 = 'priority_fifo' THEN queue_priority ELSE 0 END DESC,
            next_eligible_at ASC,
            CASE WHEN $5 = 'lifo' THEN -queue_sequence ELSE queue_sequence END ASC
          LIMIT 25
        `, [tenantId, settings.max_attempts_per_lead, Number(settings.dialer_round ?? 1), Number(settings.folder_rotation_cursor ?? 0), settings.queue_strategy ?? 'fifo']),
        this.db.query(`SELECT count(*)::int AS count FROM lead_folders WHERE tenant_id = $1 AND is_active = true`, [tenantId]),
      ]);

      for (let i = 0; i < Math.min(sdrs.rows.length, numbers.rows.length, leads.rows.length); i++) {
        const sdr = sdrs.rows[i];
        if (!this.gateway.isConnected(sdr.id)) continue;
        const lead = leads.rows[i];
        // Skip self-calls: WhatsApp closes the media immediately when the line
        // dials its own number. Try every eligible line so a rate-limited line
        // does not prevent a healthy connected line from serving this lead.
        const candidateNumbers = numbers.rows.filter((row: any) => !isSelfCallNumber(row.phone, lead.phone));
        for (const number of candidateNumbers) {
          const token = randomUUID();
          const reserved = await this.redis.reserve({
            tenantId, token, globalMax: settings.global_max_concurrent_calls,
            numberMax: number.max_concurrent_calls, numberId: number.id, waxumSessionId: numberSessionId(number),
            ...numberRateConfig(number),
            ...dialerPacingConfig(settings),
            leadId: lead.id, sdrId: sdr.id,
            ttlMs: (Number(settings.ring_timeout_seconds) + 60) * 1000,
          });
          if (!reserved) continue;
          try {
            await this.startReservedCall(sdr, number, lead, settings, token, 'automatico', tenantId);
          } catch (error) {
            this.logger.error(`Could not reserve call: ${safeOperationalError(error)}`);
            Sentry.captureException(error);
          }
          break;
        }
      }
      const round = Number(settings.dialer_round ?? 1);
      const roundState = await this.db.query(`
        SELECT
          EXISTS (
            SELECT 1
            FROM leads l
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait') AND l.attempts < $2
              AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
              AND l.last_auto_round < $3 AND l.next_eligible_at <= now()
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          ) AS has_ready_unattempted,
          EXISTS (
            SELECT 1
            FROM leads l
            JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
            WHERE l.tenant_id = $1 AND f.is_active = true AND l.do_not_call = false
              AND l.status IN ('queued', 'retry_wait', 'reserved', 'dialing', 'media_active')
              AND NOT EXISTS (SELECT 1 FROM lead_callbacks cb WHERE cb.tenant_id = l.tenant_id AND cb.lead_id = l.id AND cb.status IN ('pending','due','reassigned'))
              AND l.attempts < $2
              AND NOT EXISTS (
                SELECT 1 FROM calls active_call
                WHERE active_call.tenant_id = l.tenant_id AND active_call.lead_id = l.id
                  AND active_call.status IN ('reserved', 'dialing', 'media_active')
              )
          ) AS has_retryable_leads
      `, [tenantId, settings.max_attempts_per_lead, round]);
      const state = roundState.rows[0];
      if (state?.has_retryable_leads && !state.has_ready_unattempted) {
        const advanced = await this.db.query(`
          UPDATE dialer_settings
          SET dialer_round = dialer_round + 1
          WHERE tenant_id = $1 AND dialer_round = $2
          RETURNING dialer_round
        `, [tenantId, round]);
        if (advanced.rows[0]) this.log(`Nova rodada automática iniciada: ${advanced.rows[0].dialer_round}`, 'info', undefined, tenantId);
      }
      const folderCount = Number(activeFolderCount.rows[0]?.count ?? 0);
      if (folderCount > 0) await this.db.query('UPDATE dialer_settings SET folder_rotation_cursor = ($1 + 1) % $2 WHERE tenant_id = $3', [Number(settings.folder_rotation_cursor ?? 0), folderCount, tenantId]);
    } catch (error) {
      this.logger.warn(`Dialer tick failed: ${safeOperationalError(error)}`);
      Sentry.captureException(error);
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
    const result = await this.db.query("SELECT id, tenant_id, waxum_session_id, status FROM whatsapp_numbers WHERE tenant_id = $1 AND status <> 'removed'", [tenantId]);
    await Promise.all(result.rows.map(async (number) => {
      try {
        const status = normalizeWaxumStatus(await this.waxum.getStatus(number.waxum_session_id));
        const updated = await this.db.query('UPDATE whatsapp_numbers SET status = $1, phone = COALESCE($2, phone) WHERE id = $3 AND tenant_id = $4 RETURNING status', [status.status, status.phone, number.id, tenantId]);
        if (updated.rows[0] && updated.rows[0].status !== number.status) {
          this.notifyOperationsChanged(tenantId, 'number_status_changed', { kind: 'number_status_changed', numberId: number.id, status: updated.rows[0].status });
        }
      } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode === 404) {
          const updated = await this.db.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1 AND tenant_id = $2 RETURNING status`, [number.id, tenantId]);
          if (updated.rows[0] && updated.rows[0].status !== number.status) {
            this.notifyOperationsChanged(tenantId, 'number_status_changed', { kind: 'number_status_changed', numberId: number.id, status: updated.rows[0].status });
          }
        } else {
          // Waxum may be temporarily unavailable; keep the last status unless
          // the session is definitively missing. A 404 is expected churn, so
          // only report anything else.
          Sentry.captureException(error);
        }
      }
    }));
  }

  private async startReservedCall(sdr: any, number: any, lead: any, settings: any, token: string, source: string, tenantId = legacyTenantId()) {
    const callId = randomUUID();
    const expires = new Date(Date.now() + Number(settings.ring_timeout_seconds) * 1000);
    const isAutomatic = source === 'automatico';
    const waxumSessionId = numberSessionId(number);
    try {
      // Última barreira antes de persistir a chamada. Protege chamadas já
      // reservadas quando a janela encerra entre a seleção e a transação.
      if (this.schedule) await this.schedule.assertAllowed(tenantId);
      await this.db.transaction(async (client) => {
        const folder = await client.query(`
          SELECT l.folder_id, f.is_active,
            (l.do_not_call = false AND NOT EXISTS (
              SELECT 1 FROM contact_suppressions cs
              WHERE cs.tenant_id = l.tenant_id AND cs.phone = l.phone AND cs.lifted_at IS NULL
            )) AS contact_allowed
          FROM leads l JOIN lead_folders f ON f.tenant_id = l.tenant_id AND f.id = l.folder_id
          WHERE l.tenant_id = $1 AND l.id = $2 FOR UPDATE OF l
        `, [tenantId, lead.id]);
        if (!folder.rows[0]) throw new Error('Lead não encontrado');
        if (folder.rows[0].contact_allowed === false) { await this.redis.incrementMetric?.('calls_blocked_suppression_total'); await this.audit?.record({ tenantId, action: 'call.blocked_suppression', entityType: 'contact' }).catch(() => undefined); throw new Error('Este telefone está na lista de não contato'); }
        if (isAutomatic && !folder.rows[0]?.is_active) throw new Error('A pasta deste lead está inativa');
        await client.query(`INSERT INTO calls (id, tenant_id, folder_id, lead_id, number_id, sdr_id, status, attempt_number, source, offer_expires_at, owner_instance_id) VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9,$10)`, [callId, tenantId, folder.rows[0].folder_id, lead.id, number.id, sdr.id, isAutomatic ? Number(lead.attempts) + 1 : 0, source, expires, runtimeInstanceId]);
        if (isAutomatic) {
          await client.query(`UPDATE leads SET status = 'reserved', attempts = attempts + 1, last_auto_round = $1 WHERE tenant_id = $2 AND id = $3`, [Number(settings.dialer_round ?? 1), tenantId, lead.id]);
        }
        await client.query(`UPDATE sdrs SET available = false, state = 'in_call', last_assigned_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, sdr.id]);
      });
      this.active.set(callId, {
        tenantId,
        token,
        numberId: number.id,
        waxumSessionId,
        leadId: lead.id,
        sdrId: sdr.id,
        mediaActive: false,
        previousSdrAvailable: Boolean(sdr.available),
        previousSdrState: String(sdr.state ?? (sdr.available ? 'available' : 'offline')),
      });
      await this.redis.incrementMetric?.('calls_started_total');
      try {
        const firstCallKey = `zapcall:metrics:first-call-recorded:${tenantId}`;
        if (await this.redis.client.set(firstCallKey, '1', 'NX').catch(() => null)) {
          const tenant = await this.db.query('SELECT created_at FROM tenants WHERE id = $1', [tenantId]);
          const createdAt = new Date(tenant.rows[0]?.created_at ?? Date.now()).getTime();
          await this.redis.observeMetric?.('tenant_time_to_first_call', Date.now() - createdAt);
        }
      } catch { /* observability must not interrupt a reserved call */ }
      // Blind dialing: on automatic calls the SDR must not learn who is being
      // called until the lead actually answers (notifyAnswered reveals it).
      // Manual calls skip this — the SDR already chose the lead themselves.
      this.log(isAutomatic ? 'Discagem automática iniciada' : 'Discagem manual iniciada', 'info', callId, tenantId);
      const browser = this.gateway.getSocket(sdr.id);
      this.gateway.sendToSdr(sdr.id, { type: 'call_reserved', callId, lead: isAutomatic ? { id: lead.id } : { id: lead.id, name: lead.name, phone: lead.phone }, number: { id: number.id, label: number.label } });
      this.gateway.broadcastToOperations?.({
        type: 'operations_changed',
        reason: 'call_reserved',
        at: new Date().toISOString(),
        activity: { kind: 'call_reserved', callId, sdrId: sdr.id, sdrName: sdr.name, leadId: lead.id, leadName: lead.name },
      }, tenantId);
      if (browser) void this.attachMedia(callId, sdr.id, browser, tenantId);
      return { callId, status: 'reserved' };
    } catch (error) {
      await this.redis.release({ tenantId, token, numberId: number.id, waxumSessionId, leadId: lead.id, sdrId: sdr.id });
      throw error;
    }
  }

  private async recoverInterruptedCalls() {
    const result = await this.db.query(`
      SELECT id, tenant_id, owner_instance_id FROM calls
      WHERE status IN ('reserved', 'dialing', 'media_active')
    `);
    for (const row of result.rows) {
      if (row.owner_instance_id && await this.redis.client.exists(`zapcall:runtime:${row.owner_instance_id}`)) continue;
      try {
        await this.finishCall(row.id, 'failed', 'api_restarted', false, row.tenant_id);
      } catch (error) {
        this.logger.error(`Could not recover call ${row.id}: ${safeOperationalError(error)}`);
        Sentry.captureException(error);
      }
    }
  }

  private async resetStaleSdrPresence() {
    const result = await this.db.query(`SELECT id, tenant_id, connection_instance_id FROM sdrs WHERE available = true OR connection_instance_id IS NOT NULL`);
    for (const row of result.rows) {
      if (row.connection_instance_id && await this.redis.client.exists(`zapcall:runtime:${row.connection_instance_id}`)) continue;
      await this.db.query(`UPDATE sdrs SET available = false, session_id = '', connection_instance_id = NULL, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END WHERE tenant_id = $1 AND id = $2`, [row.tenant_id, row.id]);
    }
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
    this.gateway.broadcastToOperations?.({
      type: 'operations_changed',
      reason: 'call_started',
      at: new Date().toISOString(),
      activity: { kind: 'call_started', callId, sdrId, leadId: row.lead_id, leadName: row.name },
    }, resource.tenantId);
    if (resource.media?.readyState === WebSocket.OPEN) this.gateway.sendToSdr(sdrId, { type: 'media_open', callId });
  }

  async attachMedia(callId: string, sdrId: string, browser: WebSocket, tenantId = legacyTenantId()) {
    const resource = this.active.get(callId);
    if (!resource || resource.tenantId !== tenantId || resource.sdrId !== sdrId) return browser.close(1008, 'call not assigned');
    const call = await this.db.query(`SELECT c.*, n.waxum_session_id, n.label, l.name, l.phone FROM calls c JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
    if (!call.rows[0]) return browser.close(1008, 'call not found');
    resource.browser = browser;
    resource.answerAbort = new AbortController();
    try {
      const settings = await this.getSettings(tenantId);
      let recipient: string;
      try {
        recipient = await this.resolveRecipient(call.rows[0].waxum_session_id, call.rows[0].phone);
        this.log('Destinatário VoIP resolvido', 'info', callId);
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        const message = String(err.message ?? error);
        // A 429 while learning the LID is transient: back the line off instead
        // of failing the lead, so we don't burn its attempt budget.
        if (err.statusCode === 429 || /\b429\b/.test(message)) {
          const wait = Number(message.match(/wait for\s+(\d+)/i)?.[1]);
          this.applyRateLimitBackoff(callId, resource, Number.isFinite(wait) ? wait : undefined);
          return;
        }
        // not_on_whatsapp / lid_unavailable: the number cannot receive a VoIP
        // call. Do not retry it in a loop — finish without a retry so it leaves
        // the queue and the organizer sees why.
        const uncallable = message === 'not_on_whatsapp' || message === 'lid_unavailable';
        if (!uncallable) Sentry.captureException(error);
        this.log(uncallable ? 'Lead sem WhatsApp disponível para chamada' : 'Waxum não conseguiu preparar o destinatário', uncallable ? 'warning' : 'error', callId);
        await this.finishCall(callId, 'failed', uncallable ? `sem_whatsapp:${message}` : `waxum_recipient_error:${message}`, uncallable);
        return;
      }
      if (resource.finishing) return;
      const media = this.waxum.openMedia(call.rows[0].waxum_session_id, recipient);
      resource.media = media;
      resource.recipient = recipient;
      resource.waxumSessionId = call.rows[0].waxum_session_id;
      resource.callPlacedAt = Date.now();
      resource.ringTimeout = setTimeout(() => {
        if (!resource.mediaActive && !resource.answerSignalReceived) void this.finishCall(callId, 'no_answer', 'ring_timeout').catch((error) => this.logger.error(`Could not finish timed out call ${callId}: ${safeOperationalError(error)}`));
      }, Number(settings.ring_timeout_seconds) * 1000);

      media.on('open', () => {
        resource.mediaOpen = true;
        if (browser.readyState === WebSocket.OPEN) {
          try { browser.send(JSON.stringify({ type: 'media_open', callId })); } catch { /* browser disconnected */ }
        }
      });
      media.on('message', async (data, isBinary) => {
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
                  resource.answerConfirmedAt ??= Date.now();
                  this.notifyAnswered(callId, sdrId, call.rows[0], resource);
                  this.log('Atendimento sinalizado pelo WhatsApp; aguardando mídia pós-atendimento', 'info', callId);
                })
                .catch((error) => {
                  if ((error as Error & { name?: string }).name === 'AbortError' || resource.finishing) return;
                  this.log('Não foi possível confirmar o atendimento', 'warning', callId);
                });
            }
          } catch (error) {
            this.log('Metadados de mídia inválidos', 'warning', callId);
            Sentry.captureException(error);
          }
          return;
        }
        // Any media frame means the relay attached endpoints — the call
        // reached the ringing/media stage, so the line is NOT reachout-blocked.
        resource.receivedAnyFrame = true;
        const pcmBytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        const pcm = analyzePcm16Le(pcmBytes);
        resource.inboundPcmSamples = (resource.inboundPcmSamples ?? 0) + pcm.sampleCount;
        resource.inboundPcmNonZeroSamples = (resource.inboundPcmNonZeroSamples ?? 0) + pcm.nonZeroSamples;
        resource.inboundPcmPeak = Math.max(resource.inboundPcmPeak ?? 0, pcm.peak);
        // Um frame de mídia pode chegar enquanto o WhatsApp ainda está tocando.
        // Silêncio não confirma atendimento e não deve chegar ao SDR. Voz
        // real, porém, é uma confirmação segura quando o canal NATS falhou:
        // o telefone só captura/envia a fala depois de atender.
        if (!resource.answerSignalReceived) {
          if (pcm.hasVoice) {
            resource.answerSignalReceived = true;
            resource.answerConfirmedAt ??= Date.now();
            this.log('Atendimento confirmado pelo áudio do cliente (fallback do canal de eventos)', 'warning', callId);
          } else {
            if (!resource.answerEventLogged) {
              resource.answerEventLogged = true;
              this.log('Áudio recebido durante o toque; aguardando confirmação de atendimento', 'info', callId);
            }
            resource.inboundDroppedPreAnswer = (resource.inboundDroppedPreAnswer ?? 0) + 1;
            return;
          }
        }
        resource.answerConfirmedAt ??= Date.now();
        resource.postAnswerPcmSamples = (resource.postAnswerPcmSamples ?? 0) + pcm.sampleCount;
        resource.postAnswerPcmNonZeroSamples = (resource.postAnswerPcmNonZeroSamples ?? 0) + pcm.nonZeroSamples;
        if (isInboundAudioStalled({
          answeredForMs: Date.now() - resource.answerConfirmedAt,
          postAnswerSamples: resource.postAnswerPcmSamples,
          postAnswerNonZeroSamples: resource.postAnswerPcmNonZeroSamples,
          microphoneNonZeroSamples: resource.micPcmNonZeroSamples ?? 0,
          minDurationMs: this.inboundAudioStallMs,
          minSamples: this.inboundAudioStallSamples,
        })) {
          this.handleInboundAudioStall(callId, resource);
          return;
        }
        const firstActiveFrame = !resource.mediaActive;
        resource.mediaActive = true;
        if (firstActiveFrame) {
          if (resource.ringTimeout) clearTimeout(resource.ringTimeout);
          resource.ringTimeout = undefined;
          try {
            await this.db.query(`UPDATE calls SET status = 'media_active', started_at = COALESCE(started_at, now()), connected_at = now() WHERE tenant_id = $1 AND id = $2`, [resource.tenantId, callId]);
          } catch (error) {
            this.logger.error(`Could not persist answered call ${callId}: ${safeOperationalError(error)}`);
            return;
          }
          this.notifyOperationsChanged(resource.tenantId, 'call_media_active', { kind: 'call_media_active', callId, sdrId });
          this.notifyAnswered(callId, sdrId, call.rows[0], resource);
          this.gateway.sendToSdr(sdrId, { type: 'media_active', callId });
          this.log('Cliente aceitou a chamada; áudio liberado para o SDR', 'info', callId);
        }
        if (browser.readyState === WebSocket.OPEN) {
          if (this.relayAudio(browser, data)) resource.inboundRelayed = (resource.inboundRelayed ?? 0) + 1;
        }
      });
      media.on('error', (error) => {
        if (/unexpected server response:\s*429/i.test(error.message)) {
          this.applyRateLimitBackoff(callId, resource);
          return;
        }
        this.log('Erro no Waxum', 'error', callId);
        void this.finishCall(callId, 'failed', `waxum_error:${safeOperationalError(error)}`).catch((finishError) => this.logger.error(`Could not finish Waxum error for ${callId}: ${safeOperationalError(finishError)}`));
      });
      media.on('unexpected-response', (_request, response) => {
        const statusCode = response.statusCode;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { if (chunks.length < 8) chunks.push(chunk); });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (statusCode === 429) {
            const waitSeconds = Number(body.match(/wait for\s+(\d+)\s*s/i)?.[1]);
            this.applyRateLimitBackoff(callId, resource, Number.isFinite(waitSeconds) ? waitSeconds : undefined);
            return;
          }
          this.log(`Waxum recusou a conexão de mídia (HTTP ${statusCode})`, 'error', callId);
          void this.finishCall(callId, 'failed', `waxum_http_error:${statusCode}`)
            .catch((finishError) => this.logger.error(`Could not finish Waxum HTTP error for ${callId}: ${safeOperationalError(finishError)}`));
        });
        response.resume();
      });
      media.on('close', async (code, reason) => {
        const detail = reason.toString().trim();
        const closeReason = detail ? `waxum_closed:${code}:${detail}` : `waxum_closed:${code}`;
        const gotSignal = resource.mediaActive || resource.receivedAnyFrame || resource.answerSignalReceived;
        const elapsed = Date.now() - (resource.callPlacedAt ?? Date.now());
        if (gotSignal) {
          // Healthy call (audio/answer reached) — the line is fine; clear any
          // instant-failure streak.
          await this.redis.client.del(`zapcall:line-failures:${resource.numberId}`).catch((error) => this.logger.error(`Could not clear line failure streak for ${callId}: ${safeOperationalError(error)}`));
        } else if (isInstantFailure(elapsed, this.FLAG_FAST_FAIL_MS)) {
          // Opened then died instantly with no audio: reachout-block signature.
          resource.rapidFailureBackoffSeconds = this.rapidFailureBackoffSeconds;
          await this.registerLineInstantFailure(resource.numberId, resource.tenantId, callId, resource)
            .catch((error) => this.logger.error(`Could not register line failure for ${callId}: ${safeOperationalError(error)}`));
        }
        void this.finishCall(callId, resource.mediaActive ? 'completed' : 'no_answer', resource.mediaActive ? 'remote_hangup' : closeReason)
          .catch((error) => this.logger.error(`Could not finish closed call ${callId}: ${safeOperationalError(error)}`));
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
        if (isBinary) {
          const pcmBytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
          let framePeak = 0;
          let nonZero = 0;
          for (let offset = 0; offset + 1 < pcmBytes.length; offset += 2) {
            const sample = pcmBytes.readInt16LE(offset);
            if (sample !== 0) nonZero += 1;
            framePeak = Math.max(framePeak, Math.abs(sample));
          }
          resource.micPcmSamples = (resource.micPcmSamples ?? 0) + Math.floor(pcmBytes.length / 2);
          resource.micPcmNonZeroSamples = (resource.micPcmNonZeroSamples ?? 0) + nonZero;
          resource.micPcmPeak = Math.max(resource.micPcmPeak ?? 0, framePeak);
          if (this.relayAudio(media, data)) resource.micFramesRelayed = (resource.micFramesRelayed ?? 0) + 1;
        }
        if (!isBinary) {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'audio_playback_status' && message.callId === callId) {
              resource.browserPlayback = {
                contextState: String(message.contextState ?? ''),
                outputSampleRate: Number(message.outputSampleRate) || 0,
                framesReceived: Number(message.framesReceived) || 0,
                framesScheduled: Number(message.framesScheduled) || 0,
                framesEnded: Number(message.framesEnded) || 0,
                framesDropped: Number(message.framesDropped) || 0,
                peak: Number(message.peak) || 0,
                queuedSeconds: Number(message.queuedSeconds) || 0,
                outputDevice: String(message.outputDevice ?? '').slice(0, 120),
                sinkMode: String(message.sinkMode ?? '').slice(0, 20),
                inputDevice: String(message.inputDevice ?? '').slice(0, 120),
              };
            }
          } catch { /* unrelated control message */ }
        }
      };
      resource.browserCloseHandler = () => {
        void this.finishCall(callId, resource.mediaActive ? 'failed' : 'cancelled', 'browser_disconnected')
          .catch((error) => this.logger.error(`Could not finish browser-disconnected call ${callId}: ${safeOperationalError(error)}`));
      };
      resource.browserErrorHandler = () => {
        void this.finishCall(callId, 'failed', 'browser_error')
          .catch((error) => this.logger.error(`Could not finish browser-error call ${callId}: ${safeOperationalError(error)}`));
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
    const isCancel = outcome === 'sdr_cancelled';
    if (resource) return this.finishCall(callId, isBrowserAudioFailure ? 'failed' : isCancel ? 'cancelled' : 'completed', outcome);
    const ownership = sdrId ? ' AND sdr_id = $4' : '';
    await this.db.query(`UPDATE calls SET outcome = $1 WHERE tenant_id = $2 AND id = $3${ownership}`, sdrId ? [outcome, tenantId, callId, sdrId] : [outcome, tenantId, callId]);
    return { ok: true };
  }

  async handleSdrDisconnected(sdrId: string, tenantId = legacyTenantId()) {
    for (const [callId, resource] of this.active.entries()) {
      if (resource.tenantId === tenantId && resource.sdrId === sdrId) await this.finishCall(callId, 'failed', 'sdr_disconnected', false, tenantId);
    }
    await this.db.query(`UPDATE sdrs SET available = false, state = CASE WHEN current_pause_id IS NULL THEN 'offline' ELSE 'post_call' END WHERE tenant_id = $1 AND id = $2`, [tenantId, sdrId]);
    this.notifyOperationsChanged(tenantId, 'sdr_disconnected', { kind: 'sdr_disconnected', sdrId });
  }

  private applyRateLimitBackoff(callId: string, resource: CallResource | undefined, waitSeconds?: number) {
    // WhatsApp/Waxum throttles outbound call initiation. When it answers 429
    // ("wait for Ns"), honor that window on the WhatsApp line instead of
    // re-dialing every tick. Re-dialing immediately keeps the rate-limit
    // window permanently open, so no call ever gets to ring.
    // Floor the backoff ABOVE WhatsApp's largest observed call-rate window
    // (~177s). If we retry a line before its penalty window clears, the attempt
    // just refreshes the window and the session never recovers. 180s+ ensures
    // the window expires before we dial that line again, so it self-heals.
    const backoff = computeRateLimitBackoffSeconds(waitSeconds);
    if (resource) resource.rateLimitBackoffSeconds = backoff;
    this.log(`Waxum limitou a linha (429); aguardando ${backoff}s antes de discar novamente nela`, 'warning', callId, resource?.tenantId);
    void this.finishCall(callId, 'cancelled', 'waxum_rate_limited')
      .catch((finishError) => this.logger.error(`Could not finish Waxum rate limit for ${callId}: ${safeOperationalError(finishError)}`));
  }

  private async recoverWaxumSession(sessionId: string, numberId: string, tenantId: string, callId: string) {
    const lockKey = `zapcall:global:lock:waxum-audio-recovery:${sessionId}`;
    const lockToken = randomUUID();
    if (!await this.redis.acquireLock(lockKey, lockToken, 45_000).catch(() => false)) return;
    try {
      this.log('Recuperando a sessao do WhatsApp apos falha de audio de entrada', 'warning', callId, tenantId);
      await this.db.query(`UPDATE whatsapp_numbers SET status = 'reconnecting' WHERE id = $1 AND tenant_id = $2`, [numberId, tenantId]);
      await this.waxum.disconnect(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 750));
      await this.waxum.reconnect(sessionId);

      let connected = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        const status = normalizeWaxumStatus(await this.waxum.getStatus(sessionId));
        if (status.connected) {
          connected = true;
          await this.db.query(`UPDATE whatsapp_numbers SET status = 'connected', phone = COALESCE($1, phone) WHERE id = $2 AND tenant_id = $3`, [status.phone, numberId, tenantId]);
          break;
        }
      }
      if (!connected) throw new Error('Waxum session did not reconnect within 15 seconds');
      await this.redis.incrementMetric('waxum_audio_recovery_success');
      this.log('Sessao do WhatsApp reconectada; linha liberada apos o cooldown de seguranca', 'info', callId, tenantId);
      this.notifyOperationsChanged(tenantId, 'number_audio_recovered', { kind: 'number_audio_recovered', numberId });
    } catch (error) {
      await this.redis.incrementMetric('waxum_audio_recovery_failure');
      await this.db.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1 AND tenant_id = $2`, [numberId, tenantId]).catch(() => undefined);
      this.log(`Falha ao recuperar a sessao do WhatsApp: ${safeOperationalError(error)}`, 'error', callId, tenantId);
      Sentry.captureException(error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  private handleInboundAudioStall(callId: string, resource: CallResource) {
    if (resource.inboundAudioStallDetected || resource.finishing) return;
    resource.inboundAudioStallDetected = true;
    resource.rapidFailureBackoffSeconds = this.inboundAudioRecoveryBackoffSeconds;
    this.log('Falha real de audio detectada: Waxum entregou apenas PCM zerado apos o atendimento; a linha sera reconectada', 'error', callId, resource.tenantId);
    void this.redis.incrementMetric('waxum_inbound_audio_stalled');
    void this.finishCall(callId, 'failed', 'waxum_inbound_audio_stalled', false, resource.tenantId)
      .then(() => this.recoverWaxumSession(resource.waxumSessionId, resource.numberId, resource.tenantId, callId))
      .catch((error) => this.logger.error(`Could not recover stalled Waxum audio for ${callId}: ${safeOperationalError(error)}`));
  }

  // A call that opens the media socket but closes almost immediately with no
  // audio and no answer is the signature of a WhatsApp reachout timelock
  // (463 MissingTcToken): the relay attaches no endpoints. After a couple of
  // these in a row on the same line, quarantine it so the dialer routes to
  // healthy lines instead of hammering (and deepening the penalty on) a
  // flagged account. A single call that produces audio resets the counter.
  private async registerLineInstantFailure(numberId: string, tenantId: string, callId: string, resource?: CallResource) {
    if (resource) resource.rapidFailureBackoffSeconds = this.rapidFailureBackoffSeconds;
    const failureKey = `zapcall:line-failures:${numberId}`;
    const count = await this.redis.client.incr(failureKey);
    if (count === 1) await this.redis.client.expire(failureKey, 24 * 60 * 60);
    if (!shouldQuarantineLine(count, this.FLAG_FAILURE_THRESHOLD)) return;
    await this.redis.client.del(failureKey);
    const hours = this.flagQuarantineHours;
    await this.db.query(`UPDATE whatsapp_numbers SET flagged_until = now() + ($1 * interval '1 hour') WHERE id = $2 AND tenant_id = $3`, [hours, numberId, tenantId]);
    this.log(`Uma linha parece bloqueada pelo WhatsApp e foi pausada por ${hours}h para proteger a conta. O discador usará as outras linhas.`, 'error', callId, tenantId);
    this.gateway.broadcast({ type: 'number_flagged', numberId, flaggedHours: hours }, tenantId);
    this.notifyOperationsChanged(tenantId, 'number_flagged', { kind: 'number_flagged', numberId, flaggedHours: hours });
  }

  async finishCall(callId: string, status: string, reason?: string, forceNoRetry = false, tenantId = legacyTenantId()) {
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
        this.log(`Áudio da chamada: entrada repassada=${resource.inboundRelayed ?? 0}, entrada descartada(pré-atendimento)=${resource.inboundDroppedPreAnswer ?? 0}, microfone repassado=${resource.micFramesRelayed ?? 0}, atendimento sinalizado=${Boolean(resource.answerSignalReceived)}, mediaAtiva=${resource.mediaActive}`, 'info', callId, tenantId);
        const playback = resource.browserPlayback;
        this.log(`Diagnóstico de reprodução: cliente→servidor pico=${resource.inboundPcmPeak ?? 0}, amostras não-zero=${resource.inboundPcmNonZeroSamples ?? 0}/${resource.inboundPcmSamples ?? 0}; SDR→cliente pico=${resource.micPcmPeak ?? 0}, amostras não-zero=${resource.micPcmNonZeroSamples ?? 0}/${resource.micPcmSamples ?? 0}; navegador=${playback ? `${playback.contextState}@${playback.outputSampleRate}Hz recebidos=${playback.framesReceived} agendados=${playback.framesScheduled} concluídos=${playback.framesEnded} descartados=${playback.framesDropped ?? 0} pico=${playback.peak} fila=${playback.queuedSeconds?.toFixed(2)}s saída=${playback.outputDevice || 'padrão do sistema'} (${playback.sinkMode || 'default'}) microfone=${playback.inputDevice || 'padrão do sistema'}` : 'sem telemetria'}`, 'info', callId, tenantId);
        // Explicitly hang up the WhatsApp call. Closing the media WS alone can
        // leave the lead's phone stuck on "Reconnecting…"; terminating by
        // call_id makes Waxum send the `<terminate>` stanza reliably.
        if (resource.waxumSessionId && resource.recipient && resource.waxumCallId) {
          await this.waxum.terminateCall(resource.waxumSessionId, resource.recipient, resource.waxumCallId)
            .then(() => this.log('Chamada encerrada no WhatsApp (terminate enviado)', 'info', callId, tenantId))
            .catch((error) => this.logger.warn(`Waxum terminate falhou para ${callId}: ${safeOperationalError(error)}`));
        }
        if (resource.media && resource.media.readyState === WebSocket.OPEN) resource.media.close();
      }
      const call = await this.db.query(`SELECT c.*, s.id AS sdr_id, s.name AS sdr_name, n.id AS number_id, n.label AS number_label, n.cooldown_seconds, l.name AS lead_name, l.phone AS lead_phone, l.attempts, ds.max_attempts_per_lead, ds.retry_delay_minutes FROM calls c JOIN sdrs s ON s.tenant_id = c.tenant_id AND s.id = c.sdr_id JOIN whatsapp_numbers n ON n.id = c.number_id JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id JOIN dialer_settings ds ON ds.tenant_id = c.tenant_id WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, callId]);
      if (!call.rows[0]) return;
      const row = call.rows[0];
      if (['completed', 'no_answer', 'failed', 'cancelled'].includes(row.status)) return;
      const isAutomatic = row.source !== 'manual';
      const { outcome, transientRateLimit, transientInfrastructureFailure, retryable, finalCallStatus, leadStatus } = computeCallOutcome({
        status, reason, forceNoRetry, isAutomatic,
        attempts: Number(row.attempts), maxAttemptsPerLead: Number(row.max_attempts_per_lead),
      });
      const requiresPostCall = Boolean(row.connected_at) && !transientInfrastructureFailure;
      const restoredAvailable = resource?.previousSdrAvailable ?? (isAutomatic ? true : false);
      const restoredState = restoredAvailable ? 'available' : (resource?.previousSdrState ?? 'offline');
      let pause: any = null;
      this.log(`Chamada encerrada: ${finalCallStatus} (${outcome})`, transientRateLimit || transientInfrastructureFailure ? 'warning' : finalCallStatus === 'failed' ? 'error' : 'info', callId, tenantId);
      await this.db.transaction(async (client) => {
        await client.query(`UPDATE calls SET status = $1, ended_at = now(), duration_seconds = CASE WHEN COALESCE(connected_at, started_at) IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - COALESCE(connected_at, started_at)))::int END, ring_duration_seconds = CASE WHEN started_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(connected_at, now()) - started_at))::int) END, connected_duration_seconds = CASE WHEN connected_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - connected_at))::int) END, outcome = $2, failure_reason = CASE WHEN $4 IN ('failed','no_answer') OR $2 = 'waxum_rate_limited' THEN $2 ELSE failure_reason END WHERE tenant_id = $5 AND id = $3 AND status NOT IN ('completed','no_answer','failed','cancelled')`, [finalCallStatus, outcome, callId, status, tenantId]);
        if (!isAutomatic) {
          // Manual calls must not alter the automatic queue or attempt budget.
        } else if (transientRateLimit || transientInfrastructureFailure) {
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
            lead_name: row.lead_name,
            lead_phone: row.lead_phone,
            call_started_at: row.connected_at,
            call_duration_seconds: row.connected_at ? Math.max(0, Math.floor((Date.now() - new Date(row.connected_at).getTime()) / 1000)) : 0,
          };
          await client.query(`UPDATE sdrs SET available = false, state = 'post_call', current_pause_id = $1 WHERE tenant_id = $2 AND id = $3`, [pauseId, tenantId, row.sdr_id]);
        } else {
          await client.query(`UPDATE sdrs SET available = $1, state = $2, current_pause_id = NULL WHERE tenant_id = $3 AND id = $4`, [restoredAvailable, restoredState, tenantId, row.sdr_id]);
        }
        if (transientRateLimit || transientInfrastructureFailure || resource?.rapidFailureBackoffSeconds) {
          // WhatsApp protection (429 or rapid-drop streak) is active. Push the
          // next-eligible time out by the backoff so the dialer stops hammering
          // this line every tick.
          // The eligibility gate is `last_call_ended_at <= now() - cooldown`, so
          // future-dating it by (backoff - cooldown) makes the line eligible
          // again only after `backoff` seconds.
          const backoff = computeRateLimitCooldownWindowSeconds(row.cooldown_seconds, transientRateLimit ? resource?.rateLimitBackoffSeconds : resource?.rapidFailureBackoffSeconds);
          await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() + (($1::int - cooldown_seconds) * interval '1 second') WHERE id = $2`, [backoff, row.number_id]);
        } else {
          await client.query(`UPDATE whatsapp_numbers SET last_call_ended_at = now() WHERE id = $1`, [row.number_id]);
        }
      });
      if (resource) await this.redis.release({ tenantId: resource.tenantId, token: resource.token, numberId: resource.numberId, waxumSessionId: resource.waxumSessionId, leadId: resource.leadId, sdrId: resource.sdrId });
      const nextState = requiresPostCall ? 'post_call' : restoredState;
      const nextAvailable = requiresPostCall ? false : restoredAvailable;
      this.gateway.sendToSdr(row.sdr_id, { type: 'call_finished', callId, status: finalCallStatus, outcome, pause, state: nextState, available: nextAvailable });
      this.gateway.broadcast({ type: 'sdr_state_changed', sdrId: row.sdr_id, state: nextState, available: nextAvailable, pause }, tenantId);
      this.notifyOperationsChanged(tenantId, 'call_finished', {
        kind: requiresPostCall ? 'post_call_started' : retryable ? 'lead_rescheduled' : 'call_finished',
        callId,
        sdrId: row.sdr_id,
        sdrName: row.sdr_name,
        leadId: row.lead_id,
        leadName: row.lead_name,
        outcome,
        state: nextState,
        available: nextAvailable,
        pause: Boolean(pause),
      });
    } finally {
      this.active.delete(callId);
      this.finishingCalls.delete(callId);
    }
  }

  // Admin break-glass: force-finish a call the operator flagged as stuck
  // ("zombie") — e.g. a runtime crashed mid-call and recoverInterruptedCalls
  // hasn't run yet, or the owning instance is unreachable. Reuses finishCall
  // so calls/leads/sdrs/number cooldown update exactly like a normal finish.
  async adminForceFinishCall(callId: string, tenantId: string, confirmActiveOwner = false) {
    const call = await this.db.query('SELECT id, status, owner_instance_id FROM calls WHERE tenant_id = $1 AND id = $2', [tenantId, callId]);
    if (!call.rows[0]) throw new NotFoundException('Chamada não encontrada');
    if (['completed', 'no_answer', 'failed', 'cancelled'].includes(call.rows[0].status)) throw new ConflictException('Chamada já finalizada');
    const ownerInstanceId = call.rows[0].owner_instance_id;
    const ownerAlive = ownerInstanceId ? Boolean(await this.redis.client.exists(`zapcall:runtime:${ownerInstanceId}`)) : false;
    if (ownerAlive && !confirmActiveOwner) throw new ConflictException('A instância dona da chamada ainda está ativa — confirme para forçar mesmo assim');
    await this.finishCall(callId, 'failed', 'admin_force_finished', true, tenantId);
    return { ok: true, ownerAlive };
  }

  // Admin break-glass: reset an SDR that is stuck in_call/post_call without a
  // valid path back to available (e.g. a crashed browser tab never sent the
  // post-call result). Finishes any active call first, then clears the pause.
  async adminForceReleaseSdr(sdrId: string, tenantId: string, confirmActiveOwner = false) {
    const sdr = await this.db.query('SELECT id, state, current_pause_id FROM sdrs WHERE tenant_id = $1 AND id = $2', [tenantId, sdrId]);
    if (!sdr.rows[0]) throw new NotFoundException('SDR não encontrado');
    if (!['in_call', 'post_call'].includes(sdr.rows[0].state)) throw new ConflictException('SDR não está travado (não está em chamada nem em pós-atendimento)');
    const activeCall = await this.db.query(`SELECT id FROM calls WHERE tenant_id = $1 AND sdr_id = $2 AND status IN ('reserved','dialing','media_active') LIMIT 1`, [tenantId, sdrId]);
    let hadActiveCall = false;
    if (activeCall.rows[0]) {
      hadActiveCall = true;
      await this.adminForceFinishCall(activeCall.rows[0].id, tenantId, confirmActiveOwner);
    }
    const hadOpenPause = Boolean(sdr.rows[0].current_pause_id);
    await this.db.transaction(async (client) => {
      await client.query(`UPDATE sdr_pauses SET ended_at = now() WHERE tenant_id = $1 AND sdr_id = $2 AND ended_at IS NULL`, [tenantId, sdrId]);
      await client.query(`UPDATE sdrs SET available = true, state = 'available', current_pause_id = NULL WHERE tenant_id = $1 AND id = $2`, [tenantId, sdrId]);
    });
    this.gateway.broadcast({ type: 'sdr_state_changed', sdrId, state: 'available', available: true, pause: null }, tenantId);
    this.notifyOperationsChanged(tenantId, 'sdr_released', { kind: 'sdr_released', sdrId });
    return { ok: true, hadActiveCall, hadOpenPause };
  }
}
