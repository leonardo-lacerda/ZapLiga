import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { ContactComplianceService, SuppressionReason } from '../contact-compliance/contact-compliance.service';
import { DialRefusedError, sanitizeExternalRef } from '../dialer/dial-intents';
import { DialerService } from '../dialer/dialer.service';
import { CALL_RESULT_CATALOG } from '../metrics/metrics.definitions';
import { CrmIntegration } from './crm-integrations.service';

const CALL_CONTROL_CHANNEL = 'zapcall:crm-integration:call-control';
const ACTIVE_STATUSES = ['reserved', 'dialing', 'media_active'];
const PIPELINE_STAGES = ['novo', 'contatado', 'qualificado', 'reuniao', 'ganho', 'perdido'];
// Mirrors the result -> stage rule DialerService.finishPause enforces.
export const STAGE_BY_RESULT: Record<string, string> = {
  interessado: 'qualificado',
  sem_interesse: 'perdido',
  retornar: 'contatado',
  reuniao_agendada: 'reuniao',
  numero_invalido: 'perdido',
  nao_ligar_novamente: 'perdido',
};

/** Maps dialer refusals to HTTP errors with a stable `code` for the CRM. */
export function toIntegrationError(error: unknown): HttpException {
  if (error instanceof DialRefusedError) return new ConflictException({ code: error.code, message: error.message, retry_after_seconds: error.retryAfterSeconds ?? null });
  if (error instanceof HttpException) return error;
  return new BadRequestException({ code: 'refused', message: String((error as Error)?.message ?? error).slice(0, 300) });
}

const lineView = (row: any) => {
  const now = Date.now();
  const protectedUntil = row.last_call_ended_at && new Date(row.last_call_ended_at).getTime() > now ? new Date(row.last_call_ended_at).toISOString() : null;
  const quarantinedUntil = row.flagged_until && new Date(row.flagged_until).getTime() > now ? new Date(row.flagged_until).toISOString() : null;
  return {
    id: row.id, label: row.label, phone: row.phone ?? null, status: row.status,
    in_call: Number(row.active_calls ?? 0) > 0,
    available_at: quarantinedUntil ?? protectedUntil,
    quarantined_until: quarantinedUntil,
    protection: { cooldown_seconds: row.cooldown_seconds, max_calls_per_window: row.max_calls_per_window, call_window_seconds: row.call_window_seconds, max_concurrent_calls: row.max_concurrent_calls },
    created_at: row.created_at,
  };
};

const callView = (row: any) => ({
  id: row.id, status: row.status, source: row.source, outcome: row.outcome ?? null, failure_reason: row.failure_reason ?? null,
  call_result: row.call_result ?? null, pipeline_stage: row.pipeline_stage ?? null, notes: row.notes ?? null,
  to_phone: row.lead_phone ?? null, lead_id: row.lead_id,
  number: { id: row.number_id, label: row.number_label ?? null, phone: row.number_phone ?? null },
  sdr: { id: row.sdr_id, external_user_id: row.external_user_id ?? null },
  external_ref: row.external_ref ?? null,
  created_at: row.created_at, started_at: row.started_at ?? null, connected_at: row.connected_at ?? null, ended_at: row.ended_at ?? null,
  duration_seconds: row.duration_seconds ?? null, ring_duration_seconds: row.ring_duration_seconds ?? null, connected_duration_seconds: row.connected_duration_seconds ?? null,
  wrap_up_completed_at: row.wrap_up_completed_at ?? null,
});

const CALL_SELECT = `SELECT c.*, l.phone AS lead_phone, n.label AS number_label, n.phone AS number_phone, a.external_user_id
  FROM calls c
  JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
  JOIN whatsapp_numbers n ON n.id = c.number_id
  LEFT JOIN crm_integration_agents a ON a.integration_id = c.integration_id AND a.sdr_id = c.sdr_id`;

@Injectable()
export class IntegrationCallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationCallsService.name);
  private subscriber?: Redis;

  constructor(private readonly db: DatabaseService, private readonly redis: RedisService, private readonly dialer: DialerService, private readonly audit: AuditService, private readonly compliance: ContactComplianceService) {}

  // A hang-up requested over HTTP reaches whichever instance runs the call.
  async onModuleInit() {
    try {
      this.subscriber = this.redis.client.duplicate();
      await this.subscriber.subscribe(CALL_CONTROL_CHANNEL);
      this.subscriber.on('message', (_channel, raw) => {
        let message: { action?: string; callId?: string; tenantId?: string };
        try { message = JSON.parse(raw); } catch { return; }
        if (message.action !== 'hangup' || !message.callId || !message.tenantId) return;
        void this.dialer.hangupIfOwned(message.callId, message.tenantId).catch((error) => this.logger.warn(`Integration hang-up failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`));
      });
    } catch (error) {
      this.logger.warn(`Integration call-control channel unavailable: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
  }

  async onModuleDestroy() { await this.subscriber?.quit().catch(() => undefined); }

  async lines(integration: CrmIntegration) {
    const result = await this.db.query(`SELECT n.*, (SELECT count(*)::int FROM calls c WHERE c.number_id = n.id AND c.status IN ('reserved', 'dialing', 'media_active')) AS active_calls
      FROM whatsapp_numbers n WHERE n.tenant_id = $1 AND n.status <> 'removed' ORDER BY n.created_at ASC`, [integration.tenant_id]);
    return { items: result.rows.map(lineView) };
  }

  lineView(row: any) { return lineView(row); }

  catalog() {
    return {
      call_results: Object.entries(CALL_RESULT_CATALOG).map(([code, item]) => ({ code, label: item.label, classification: item.classification, default_pipeline_stage: STAGE_BY_RESULT[code] ?? null, requires_notes: !['sem_interesse', 'numero_invalido', 'nao_ligar_novamente'].includes(code), requires_callback_at: code === 'retornar' })),
      pipeline_stages: PIPELINE_STAGES,
    };
  }

  async createDialIntent(integration: CrmIntegration, input: { sdrId: string; numberId: string; phone: string; name?: string; externalRef?: Record<string, unknown>; leadExternalId?: string }) {
    const linked = await this.db.query('SELECT 1 FROM crm_integration_agents WHERE integration_id = $1 AND sdr_id = $2 LIMIT 1', [integration.id, input.sdrId]);
    if (!linked.rows[0]) throw new NotFoundException({ code: 'agent_not_linked', message: 'Agente não vinculado a esta integração' });
    try {
      return await this.dialer.createDialIntent({
        tenantId: integration.tenant_id, integrationId: integration.id, sdrId: input.sdrId, numberId: input.numberId,
        phone: input.phone, name: input.name, externalRef: sanitizeExternalRef(input.externalRef), leadExternalId: input.leadExternalId?.trim() || null,
      });
    } catch (error) { throw toIntegrationError(error); }
  }

  private async findCall(integration: CrmIntegration, callId: string) {
    const result = await this.db.query(`${CALL_SELECT} WHERE c.tenant_id = $1 AND c.id = $2 AND c.integration_id = $3 LIMIT 1`, [integration.tenant_id, callId, integration.id]);
    if (!result.rows[0]) throw new NotFoundException({ code: 'call_not_found', message: 'Ligação não encontrada' });
    return result.rows[0];
  }

  async get(integration: CrmIntegration, callId: string) { return callView(await this.findCall(integration, callId)); }

  async list(integration: CrmIntegration, filters: { externalCallId?: string; limit?: number; offset?: number }) {
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const params: unknown[] = [integration.tenant_id, integration.id];
    let clause = 'c.tenant_id = $1 AND c.integration_id = $2';
    if (filters.externalCallId?.trim()) { params.push(filters.externalCallId.trim()); clause += ` AND c.external_ref->>'call_id' = $${params.length}`; }
    params.push(limit, offset);
    const result = await this.db.query(`${CALL_SELECT} WHERE ${clause} ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: result.rows.map(callView), limit, offset };
  }

  async hangup(integration: CrmIntegration, callId: string) {
    const call = await this.findCall(integration, callId);
    if (!ACTIVE_STATUSES.includes(call.status)) return { ok: true, call_id: callId, status: call.status, already_finished: true };
    const handled = await this.dialer.hangupIfOwned(callId, integration.tenant_id);
    if (!handled) await this.redis.client.publish(CALL_CONTROL_CHANNEL, JSON.stringify({ action: 'hangup', callId, tenantId: integration.tenant_id }));
    await this.audit.record({ tenantId: integration.tenant_id, action: 'crm_integration.call_hangup_requested', entityType: 'call', entityId: callId, metadata: { integrationId: integration.id } });
    return { ok: true, call_id: callId, requested: true };
  }

  /**
   * Records the CRM's result on ZapLiga's own post-call pause (stage history, callbacks,
   * do-not-call). If the agent already moved on to another call, the pause was released and
   * the result stays only in the CRM.
   */
  async wrapUp(integration: CrmIntegration, callId: string, input: { callResult: string; pipelineStage?: string; notes?: string; callbackAt?: string }) {
    const call = await this.findCall(integration, callId);
    const pause = (await this.db.query('SELECT id, sdr_id FROM sdr_pauses WHERE tenant_id = $1 AND call_id = $2 AND ended_at IS NULL LIMIT 1', [integration.tenant_id, call.id])).rows[0];
    if (!pause) throw new ConflictException({ code: 'wrap_up_closed', message: 'O pós-atendimento desta ligação já foi encerrado' });
    try {
      return await this.dialer.finishPause(pause.sdr_id, pause.id, {
        callResult: input.callResult,
        pipelineStage: input.pipelineStage ?? STAGE_BY_RESULT[input.callResult] ?? 'contatado',
        notes: input.notes?.trim() || 'Resultado registrado no Franco CRM.',
        callbackAt: input.callbackAt,
        continueAvailable: false,
      }, integration.tenant_id);
    } catch (error) { throw toIntegrationError(error); }
  }

  async suppress(integration: CrmIntegration, input: { phone: string; reason?: SuppressionReason; notes?: string }) {
    const suppression = await this.compliance.suppress({ tenantId: integration.tenant_id, phone: input.phone, reason: input.reason ?? 'requested_opt_out', source: 'api', notes: input.notes, actorUserId: null });
    return { id: suppression.id, phone: suppression.phone, already_existed: Boolean(suppression.alreadyExisted) };
  }
}
