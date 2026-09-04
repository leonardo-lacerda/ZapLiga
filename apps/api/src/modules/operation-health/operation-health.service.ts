import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { DialerScheduleService } from '../dialer-schedule/dialer-schedule.service';
import { calculateOperationHealth, HEALTH_FORMULA_VERSION, HealthResult, OperationHealthSignals } from './health-formula';
import { HealthRecommendationsAdapter } from './health-recommendations.adapter';

const CONNECTED_STATUSES = ['connected', 'online', 'ready', 'authenticated'];
const ACTIVE_CALL_STATUSES = ['reserved', 'dialing', 'media_active'];

const numberValue = (value: unknown) => Number(value ?? 0) || 0;

type CollectedHealth = {
  result: HealthResult;
  evidence: Record<string, unknown>;
  collectedAt: string;
};

@Injectable()
export class OperationHealthService implements OnModuleInit, OnModuleDestroy {
  private snapshotTimer?: NodeJS.Timeout;
  private readonly snapshotLockTtlMs = 30_000;

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly schedule?: DialerScheduleService,
    @Optional() private readonly recommendations?: HealthRecommendationsAdapter,
  ) {}

  onModuleInit() {
    this.snapshotTimer = setInterval(() => {
      void this.snapshotAllTenants().catch(() => undefined);
    }, 5 * 60 * 1000);
    this.snapshotTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  async current(tenantId: string) {
    const collected = await this.collect(tenantId);
    const previous = (await this.db.query<{ score: number; created_at: string }>(
      `SELECT score, created_at FROM operation_health_snapshots WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0];
    await this.persist(tenantId, collected);
    await this.recommendations?.sync(tenantId, collected.result, collected.evidence, collected.collectedAt).catch(() => undefined);
    return this.toResponse(collected, this.trend(previous, collected.result.score));
  }

  async history(tenantId: string, limit = 100) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const rows = await this.db.query(`
      SELECT id, score, state, component_scores, reason_codes, evidence, sample_size, formula_version, created_at
      FROM operation_health_snapshots
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [tenantId, safeLimit]);
    return {
      formulaVersion: HEALTH_FORMULA_VERSION,
      items: rows.rows.map((row: any) => ({
        id: row.id,
        score: numberValue(row.score),
        state: row.state,
        components: row.component_scores ?? [],
        reasonCodes: row.reason_codes ?? [],
        evidence: row.evidence ?? {},
        sampleSize: numberValue(row.sample_size),
        formulaVersion: row.formula_version,
        createdAt: row.created_at,
      })),
    };
  }

  async snapshotAllTenants() {
    const tenants = await this.db.query<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active' ORDER BY id`);
    const results: Array<{ tenantId: string; state: string; score: number }> = [];
    for (const tenant of tenants.rows) {
      const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const lockKey = `zapcall:tenant:${tenant.id}:operation-health:snapshot`;
      const acquired = this.redis ? await this.redis.acquireLock(lockKey, token, this.snapshotLockTtlMs).catch(() => false) : true;
      if (!acquired) continue;
      try {
        const collected = await this.collect(tenant.id);
        await this.persist(tenant.id, collected);
        await this.recommendations?.sync(tenant.id, collected.result, collected.evidence, collected.collectedAt).catch(() => undefined);
        results.push({ tenantId: tenant.id, state: collected.result.state, score: collected.result.score });
      } finally {
        if (this.redis) await this.redis.releaseLock(lockKey, token).catch(() => undefined);
      }
    }
    return { capturedAt: new Date().toISOString(), items: results };
  }

  private async collect(tenantId: string): Promise<CollectedHealth> {
    const collectedAt = new Date().toISOString();
    const schedule = await this.scheduleState(tenantId);
    const [numbers, calls, team, queue, suppressions, reconnections] = await Promise.all([
      this.db.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = ANY($2::text[]))::int AS connected,
          count(*) FILTER (WHERE flagged_until > now())::int AS quarantined,
          count(*) FILTER (WHERE flagged_until <= now() AND flagged_until IS NOT NULL)::int AS protected_expired,
          count(*) FILTER (WHERE (flagged_until IS NULL OR flagged_until <= now())
            AND last_call_ended_at IS NOT NULL
            AND last_call_ended_at > now() - (cooldown_seconds * interval '1 second'))::int AS cooldown,
          COALESCE(sum(max_concurrent_calls), 0)::int AS capacity,
          count(*) FILTER (WHERE status = 'removed')::int AS removed
        FROM whatsapp_numbers
        WHERE tenant_id = $1
      `, [tenantId, CONNECTED_STATUSES]),
      this.db.query(`
        SELECT
          count(*) FILTER (WHERE status IN ('completed','no_answer','failed','cancelled'))::int AS attempts,
          count(*) FILTER (WHERE status IN ('failed','cancelled') OR failure_reason IS NOT NULL)::int AS failures,
          count(*) FILTER (WHERE failure_reason = 'waxum_rate_limited' OR failure_reason ILIKE '%429%')::int AS rate_limited,
          count(*) FILTER (WHERE failure_reason IN ('waxum_inbound_audio_stalled', 'browser_disconnected'))::int AS rapid_failures
        FROM calls
        WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'
      `, [tenantId]),
      this.db.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE available = true AND state = 'available')::int AS available,
          count(*) FILTER (WHERE state = 'in_call')::int AS in_call,
          count(*) FILTER (WHERE state = 'post_call')::int AS post_call,
          count(*) FILTER (WHERE state = 'offline')::int AS offline
        FROM sdrs WHERE tenant_id = $1
      `, [tenantId]),
      this.db.query(`
        SELECT
          count(*) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued','retry_wait') AND l.next_eligible_at <= now() AND l.attempts < ds.max_attempts_per_lead)::int AS ready,
          count(*) FILTER (WHERE l.do_not_call = false AND l.status IN ('queued','retry_wait') AND l.next_eligible_at > now() AND l.attempts < ds.max_attempts_per_lead)::int AS waiting,
          count(*) FILTER (WHERE l.do_not_call = false AND l.attempts >= ds.max_attempts_per_lead)::int AS exhausted
        FROM leads l
        JOIN dialer_settings ds ON ds.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
      `, [tenantId]),
      this.db.query(`SELECT count(*)::int AS count FROM contact_suppressions WHERE tenant_id = $1 AND lifted_at IS NULL`, [tenantId]),
      this.db.query(`
        SELECT count(*)::int AS count
        FROM number_status_history
        WHERE tenant_id = $1 AND changed_at >= now() - interval '24 hours'
          AND (to_status = ANY($2::text[]) OR from_status = ANY($3::text[]))
      `, [tenantId, CONNECTED_STATUSES, ['disconnected']]),
    ]);
    const dueCallbacks = await this.db.query(`
      SELECT count(*)::int AS count FROM lead_callbacks
      WHERE tenant_id = $1 AND status IN ('pending','due','reassigned') AND due_at <= now()
    `, [tenantId]);
    const numberRow: any = numbers.rows[0] ?? {};
    const callRow: any = calls.rows[0] ?? {};
    const teamRow: any = team.rows[0] ?? {};
    const queueRow: any = queue.rows[0] ?? {};
    const totalNumbers = numberValue(numberRow.total);
    const connectedNumbers = numberValue(numberRow.connected);
    const protectedNumbers = numberValue(numberRow.quarantined);
    const cooldownNumbers = numberValue(numberRow.cooldown);
    const signals: OperationHealthSignals = {
      numbers: {
        total: totalNumbers,
        connected: connectedNumbers,
        cooldown: cooldownNumbers,
        quarantined: protectedNumbers,
        rateLimited: numberValue(callRow.rate_limited),
        rapidFailures: numberValue(callRow.rapid_failures),
      },
      calls: { attempts: numberValue(callRow.attempts), failures: numberValue(callRow.failures) },
      capacity: { total: numberValue(numberRow.capacity), active: await this.activeCalls(tenantId) },
      team: { total: numberValue(teamRow.total), available: numberValue(teamRow.available) },
      queue: {
        ready: numberValue(queueRow.ready),
        waiting: numberValue(queueRow.waiting),
        dueCallbacks: numberValue(dueCallbacks.rows[0]?.count),
        exhausted: numberValue(queueRow.exhausted),
      },
      compliance: {
        scheduleAllowed: schedule.allowed,
        suppressionBlocks: numberValue(suppressions.rows[0]?.count),
        policyBlocks: 0,
      },
    };
    const result = calculateOperationHealth(signals);
    const evidence = {
      window: '24h',
      numbers: { total: totalNumbers, connected: connectedNumbers, cooldown: cooldownNumbers, quarantined: protectedNumbers, removed: numberValue(numberRow.removed) },
      calls: { attempts: numberValue(callRow.attempts), failures: numberValue(callRow.failures), rateLimited: numberValue(callRow.rate_limited), rapidFailures: numberValue(callRow.rapid_failures) },
      capacity: { configured: numberValue(numberRow.capacity), active: signals.capacity.active, available: Math.max(0, numberValue(numberRow.capacity) - signals.capacity.active) },
      team: { total: numberValue(teamRow.total), available: numberValue(teamRow.available), inCall: numberValue(teamRow.in_call), postCall: numberValue(teamRow.post_call), offline: numberValue(teamRow.offline) },
      queue: { ready: signals.queue.ready, waiting: signals.queue.waiting, dueCallbacks: signals.queue.dueCallbacks, attemptsExhausted: signals.queue.exhausted },
      compliance: { schedule, activeSuppressions: signals.compliance.suppressionBlocks },
      reconnections24h: numberValue(reconnections.rows[0]?.count),
    };
    return { result, evidence, collectedAt };
  }

  private async activeCalls(tenantId: string) {
    const result = await this.db.query(`SELECT count(*)::int AS count FROM calls WHERE tenant_id = $1 AND status = ANY($2::text[])`, [tenantId, ACTIVE_CALL_STATUSES]);
    return numberValue(result.rows[0]?.count);
  }

  private async scheduleState(tenantId: string) {
    const flag = await this.db.query(`SELECT schedule_enforcement FROM tenant_feature_flags WHERE tenant_id = $1`, [tenantId]);
    if (flag.rows[0] && flag.rows[0].schedule_enforcement === false) return { allowed: true, reason: 'feature_disabled', timezone: null, localDate: null, localTime: null, nextOpenAt: null };
    try {
      const state = this.schedule ? await this.schedule.evaluate(tenantId, new Date(), true) : { allowed: true, reason: 'schedule_unavailable', timezone: null, local_date: null, local_time: null, next_open_at: null };
      return { allowed: Boolean(state.allowed), reason: state.reason, timezone: state.timezone, localDate: state.local_date, localTime: state.local_time, nextOpenAt: state.next_open_at ?? null };
    } catch {
      return { allowed: true, reason: 'schedule_unavailable', timezone: null, localDate: null, localTime: null, nextOpenAt: null };
    }
  }

  private async persist(tenantId: string, collected: CollectedHealth) {
    const result = collected.result;
    await this.db.query(`
      INSERT INTO operation_health_snapshots
        (tenant_id, state, score, component_scores, reason_codes, evidence, sample_size, formula_version)
      SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8
      WHERE NOT EXISTS (
        SELECT 1 FROM operation_health_snapshots
        WHERE tenant_id = $1 AND created_at >= now() - interval '1 minute'
      )
    `, [tenantId, result.state, result.score, JSON.stringify(result.components), JSON.stringify(result.reasonCodes), JSON.stringify(collected.evidence), result.sampleSize.attempts, result.formulaVersion]);
  }

  private trend(previous: { score: number; created_at: string } | undefined, currentScore: number) {
    if (!previous) return { direction: 'flat', delta: 0, previousScore: null, previousAt: null };
    const delta = currentScore - numberValue(previous.score);
    return { direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', delta, previousScore: numberValue(previous.score), previousAt: previous.created_at };
  }

  private nextSafeAction(result: HealthResult, evidence: Record<string, any>) {
    if (result.state === 'blocked') return 'Pause a discagem e regularize o bloqueio operacional indicado.';
    if (result.reasonCodes.includes('no_connected_number')) return 'Conecte ou reconecte uma linha antes de iniciar a discagem.';
    if (result.reasonCodes.includes('rate_limited_numbers') || result.reasonCodes.includes('rapid_failure_streak')) return 'Mantenha as proteções ativas e aguarde a recuperação das linhas.';
    if (result.reasonCodes.includes('no_available_sdr')) return 'Conecte um SDR disponível ou reduza a fila ativa.';
    if (result.reasonCodes.includes('capacity_exhausted')) return 'Aguarde a liberação de capacidade antes de aumentar o ritmo.';
    if (result.state === 'insufficient_data') return 'Faça uma amostra inicial de chamadas para formar o score interno.';
    if (numberValue(evidence.queue?.dueCallbacks) > 0) return 'Revise os callbacks vencidos antes de colocar mais leads na fila.';
    return 'Continue monitorando a operação; nenhuma intervenção imediata é necessária.';
  }

  private toResponse(collected: CollectedHealth, trend: Record<string, unknown>) {
    return {
      score: collected.result.score,
      state: collected.result.state,
      label: collected.result.state === 'insufficient_data' ? 'Dados insuficientes' : collected.result.state,
      formulaVersion: collected.result.formulaVersion,
      internalScoreNotice: 'Score interno do ZapLiga; não representa aprovação ou limite oficial do WhatsApp.',
      components: collected.result.components,
      reasonCodes: collected.result.reasonCodes,
      hardBlocks: collected.result.hardBlocks,
      sampleSize: collected.result.sampleSize,
      evidence: collected.evidence,
      trend,
      nextSafeAction: this.nextSafeAction(collected.result, collected.evidence),
      collectedAt: collected.collectedAt,
    };
  }
}
