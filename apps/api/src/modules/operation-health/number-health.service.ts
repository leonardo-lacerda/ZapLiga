import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { calculateNumberHealth, HEALTH_FORMULA_VERSION } from './health-formula';

const CONNECTED_STATUSES = ['connected', 'online', 'ready', 'authenticated'];
const numberValue = (value: unknown) => Number(value ?? 0) || 0;

@Injectable()
export class NumberHealthService {
  constructor(private readonly db: DatabaseService) {}

  async get(tenantId: string, numberId: string) {
    const number = (await this.db.query(`
      SELECT id, label, status, phone, flagged_until, cooldown_seconds, last_call_ended_at, max_concurrent_calls
      FROM whatsapp_numbers WHERE tenant_id = $1 AND id = $2 AND status <> 'removed'
    `, [tenantId, numberId])).rows[0] as any;
    if (!number) throw new NotFoundException('Número não encontrado');
    const stats = (await this.db.query(`
      SELECT
        count(*) FILTER (WHERE status IN ('completed','no_answer','failed','cancelled'))::int AS attempts,
        count(*) FILTER (WHERE status IN ('failed','cancelled') OR failure_reason IS NOT NULL)::int AS failures,
        count(*) FILTER (WHERE failure_reason = 'waxum_rate_limited' OR failure_reason ILIKE '%429%')::int AS rate_limited,
        count(*) FILTER (WHERE failure_reason IN ('waxum_inbound_audio_stalled', 'browser_disconnected'))::int AS rapid_failures
      FROM calls WHERE tenant_id = $1 AND number_id = $2 AND created_at >= now() - interval '24 hours'
    `, [tenantId, numberId])).rows[0] as any ?? {};
    const cooldown = Boolean(number.last_call_ended_at && new Date(number.last_call_ended_at).getTime() + numberValue(number.cooldown_seconds) * 1000 > Date.now());
    const quarantine = Boolean(number.flagged_until && new Date(number.flagged_until).getTime() > Date.now());
    const health = calculateNumberHealth({
      status: String(number.status),
      calls: { attempts: numberValue(stats.attempts), failures: numberValue(stats.failures), rateLimited: numberValue(stats.rate_limited), rapidFailures: numberValue(stats.rapid_failures) },
      protections: { cooldown, quarantine },
    });
    const cooldownUntil = number.last_call_ended_at && cooldown
      ? new Date(new Date(number.last_call_ended_at).getTime() + numberValue(number.cooldown_seconds) * 1000).toISOString()
      : null;
    const flaggedUntil = quarantine ? new Date(number.flagged_until).toISOString() : null;
    const nextReleaseAt = [cooldownUntil, flaggedUntil].filter(Boolean).sort()[0] ?? null;
    return {
      numberId: number.id,
      label: number.label,
      status: number.status,
      score: health.score,
      state: health.state,
      formulaVersion: HEALTH_FORMULA_VERSION,
      internalScoreNotice: 'Score interno do ZapLiga; não representa aprovação ou limite oficial do WhatsApp.',
      components: health.components,
      reasonCodes: health.reasonCodes,
      hardBlocks: health.hardBlocks,
      sampleSize: health.sampleSize,
      protection: { cooldown, quarantine, cooldownUntil, flaggedUntil: number.flagged_until ?? null, nextReleaseAt, cooldownSeconds: numberValue(number.cooldown_seconds) },
      evidence: { calls24h: stats, connected: CONNECTED_STATUSES.includes(String(number.status).toLowerCase()), capacity: numberValue(number.max_concurrent_calls) },
      nextSafeAction: quarantine || cooldown ? 'Mantenha a proteção ativa e aguarde a próxima liberação estimada.' : health.state === 'healthy' ? 'Nenhuma intervenção imediata é necessária.' : 'Revise a conexão e as falhas recentes desta linha antes de aumentar o ritmo.',
      collectedAt: new Date().toISOString(),
    };
  }

  async events(tenantId: string, numberId: string, limit = 100) {
    const exists = await this.db.query(`SELECT 1 FROM whatsapp_numbers WHERE tenant_id = $1 AND id = $2 AND status <> 'removed'`, [tenantId, numberId]);
    if (!exists.rows[0]) throw new NotFoundException('Número não encontrado');
    await this.syncStatusHistory(tenantId, numberId);
    await this.syncProtectionEvents(tenantId, numberId);
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const rows = await this.db.query(`
      SELECT id, source_event_id, event_type, actor_type, metadata, occurred_at, created_at
      FROM number_health_events
      WHERE tenant_id = $1 AND number_id = $2
      ORDER BY occurred_at DESC, id DESC
      LIMIT $3
    `, [tenantId, numberId, safeLimit]);
    return {
      formulaVersion: HEALTH_FORMULA_VERSION,
      items: rows.rows.map((row: any) => ({ id: row.id, sourceEventId: row.source_event_id, eventType: row.event_type, actorType: row.actor_type, metadata: row.metadata ?? {}, occurredAt: row.occurred_at, createdAt: row.created_at })),
    };
  }

  private async syncStatusHistory(tenantId: string, numberId: string) {
    await this.db.query(`
      INSERT INTO number_health_events (tenant_id, number_id, source_event_id, event_type, actor_type, metadata, occurred_at)
      SELECT h.tenant_id, h.number_id, 'number_status_history:' || h.id,
        CASE
          WHEN lower(h.to_status) IN ('connected','online','ready','authenticated')
            THEN CASE WHEN lower(COALESCE(h.from_status, '')) = 'disconnected' THEN 'reconnected' ELSE 'connected' END
          WHEN lower(h.to_status) = 'disconnected' THEN 'disconnected'
          ELSE 'disconnected'
        END,
        'automatic', jsonb_build_object('fromStatus', h.from_status, 'toStatus', h.to_status, 'source', 'number_status_history'), h.changed_at
      FROM number_status_history h
      WHERE h.tenant_id = $1 AND h.number_id = $2
      ON CONFLICT (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
    `, [tenantId, numberId]);
  }

  private async syncProtectionEvents(tenantId: string, numberId: string) {
    const row = (await this.db.query(`SELECT flagged_until, last_call_ended_at, cooldown_seconds FROM whatsapp_numbers WHERE tenant_id = $1 AND id = $2`, [tenantId, numberId])).rows[0] as any;
    if (!row) return;
    if (row.flagged_until && new Date(row.flagged_until).getTime() > Date.now()) {
      await this.db.query(`
        INSERT INTO number_health_events (tenant_id, number_id, source_event_id, event_type, actor_type, metadata, occurred_at)
        VALUES ($1, $2, $3, 'quarantine_started', 'automatic', $4::jsonb, now())
        ON CONFLICT (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
      `, [tenantId, numberId, `number:quarantine:${new Date(row.flagged_until).toISOString()}`, JSON.stringify({ flaggedUntil: row.flagged_until, source: 'whatsapp_numbers.flagged_until' })]);
    }
    if (row.last_call_ended_at && new Date(row.last_call_ended_at).getTime() + numberValue(row.cooldown_seconds) * 1000 > Date.now()) {
      await this.db.query(`
        INSERT INTO number_health_events (tenant_id, number_id, source_event_id, event_type, actor_type, metadata, occurred_at)
        VALUES ($1, $2, $3, 'cooldown_started', 'automatic', $4::jsonb, $5)
        ON CONFLICT (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
      `, [tenantId, numberId, `number:cooldown:${new Date(row.last_call_ended_at).toISOString()}`, JSON.stringify({ cooldownSeconds: numberValue(row.cooldown_seconds), source: 'whatsapp_numbers.last_call_ended_at' }), row.last_call_ended_at]);
    }
  }
}
