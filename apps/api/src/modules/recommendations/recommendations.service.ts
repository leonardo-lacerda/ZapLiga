import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { DialerScheduleService } from '../dialer-schedule/dialer-schedule.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../metrics/metrics.service';
import { MetricsSummaryQueryDto } from '../metrics/dto/metrics-summary-query.dto';
import { buildRecommendationCandidates } from './recommendations.catalog';
import { RecommendationsRepository } from './recommendations.repository';
import { RecommendationEventType, RecommendationStatus } from './recommendations.types';

@Injectable()
export class RecommendationsService {
  constructor(
    private readonly repo: RecommendationsRepository,
    private readonly metrics: MetricsService,
    private readonly flags: FeatureFlagsService,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Optional() private readonly schedule?: DialerScheduleService,
  ) {}

  private async assertEnabled(tenantId: string) { await this.flags.assertEnabled(tenantId, 'recommendations'); }

  private map(row: any) {
    return {
      id: row.id, tenantId: row.tenant_id, campaignId: row.campaign_id, code: row.code, scopeKey: row.scope_key,
      status: row.status, severity: row.severity ?? (row.code === 'queue_stalled' ? 'critical' : 'warning'),
      title: row.title_key, evidence: row.evidence, recommendedAction: row.recommended_action, confidence: row.confidence === null ? null : Number(row.confidence),
      impactScope: row.impact_scope, ruleVersion: Number(row.rule_version), expiresAt: row.expires_at, snoozedUntil: row.snoozed_until,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private async refresh(tenantId: string) {
    const summary = await this.metrics.summary(tenantId, new MetricsSummaryQueryDto());
    const dialer = (await this.db.query('SELECT running FROM dialer_settings WHERE tenant_id=$1', [tenantId])).rows[0];
    const alerts = [...summary.alerts];
    if (!dialer?.running && Number(summary.realtime?.leadsReady ?? 0) > 0) alerts.push({
      id: 'dialer_paused_with_queue', code: 'dialer_paused_with_queue', severity: 'warning', title: 'Discador pausado com leads prontos',
      evidence: `${summary.realtime.leadsReady} lead(s) estão prontos, mas o discador está pausado.`, recommendedAction: 'Inicie o discador depois de conferir os pré-requisitos.',
    });
    const candidates = buildRecommendationCandidates(alerts, summary.freshness.generatedAt, summary.kpis.callsMade.numerator);
    const rows = await this.repo.sync(tenantId, candidates, summary.freshness.generatedAt);
    return { rows, generatedAt: summary.freshness.generatedAt };
  }

  async list(tenantId: string, status?: RecommendationStatus, limit = 3) {
    await this.assertEnabled(tenantId);
    const refreshed = await this.refresh(tenantId);
    const rows = status && !['active', 'snoozed'].includes(status) ? await this.repo.list(tenantId, status, limit) : refreshed.rows.filter((row) => !status || row.status === status).slice(0, Math.min(100, Math.max(1, Number(limit) || 3)));
    return { items: rows.map((row) => this.map(row)), generatedAt: refreshed.generatedAt, total: rows.length };
  }

  async get(tenantId: string, id: string) {
    await this.assertEnabled(tenantId);
    const row = await this.repo.get(tenantId, id);
    if (!row) throw new NotFoundException('Recomendação não encontrada');
    return this.map(row);
  }

  async event(tenantId: string, id: string, actorUserId: string, eventType: RecommendationEventType, metadata: Record<string, unknown> = {}) {
    await this.assertEnabled(tenantId);
    const row = await this.repo.get(tenantId, id);
    if (!row) throw new NotFoundException('Recomendação não encontrada');
    if (eventType === 'snoozed') await this.repo.updateStatus(tenantId, id, 'snoozed', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    if (eventType === 'dismissed') await this.repo.updateStatus(tenantId, id, 'dismissed');
    if (eventType === 'resolved') await this.repo.updateStatus(tenantId, id, 'resolved');
    const event = await this.repo.recordEvent(tenantId, id, eventType, actorUserId, metadata);
    return { ok: true, eventType, recommendationId: id, eventId: event?.id ?? null };
  }

  async dismiss(tenantId: string, id: string, actorUserId: string) { return this.event(tenantId, id, actorUserId, 'dismissed'); }
  async snooze(tenantId: string, id: string, actorUserId: string) { return this.event(tenantId, id, actorUserId, 'snoozed'); }

  async apply(tenantId: string, id: string, actorUserId: string) {
    await this.assertEnabled(tenantId);
    const row = await this.repo.get(tenantId, id);
    if (!row) throw new NotFoundException('Recomendação não encontrada');
    if (!['active', 'snoozed'].includes(String(row.status ?? 'active'))) throw new ConflictException('Esta recomendação já não está ativa');
    const action = row.recommended_action ?? {};
    const actionType = String(row.action_type ?? action.type ?? '');
    const before = await this.actionState(tenantId, actionType, action.payload ?? {});
    try {
      const result = await this.executeAction(tenantId, actorUserId, actionType, action.payload ?? {});
      const after = await this.actionState(tenantId, actionType, action.payload ?? {});
      await this.repo.recordEvent(tenantId, id, 'applied', actorUserId, { actionType, before, after, result });
      await this.repo.updateStatus(tenantId, id, 'resolved');
      return { ok: true, action, status: 'resolved', result };
    } catch (error) {
      await this.repo.recordEvent(tenantId, id, 'failed', actorUserId, { actionType, before, error: String(error instanceof Error ? error.message : error).slice(0, 240) }).catch(() => undefined);
      throw error;
    }
  }

  private async actionState(tenantId: string, actionType: string, payload: Record<string, any>) {
    if (actionType === 'pause_campaign') return (await this.db.query('SELECT id, status, lock_version FROM campaigns WHERE tenant_id=$1 AND id=$2', [tenantId, String(payload.campaignId ?? '')])).rows[0] ?? null;
    if (actionType === 'start_dialer') return (await this.db.query('SELECT running FROM dialer_settings WHERE tenant_id=$1', [tenantId])).rows[0] ?? { running: false };
    if (actionType === 'disable_number') return (await this.db.query('SELECT id, status, flagged_until FROM whatsapp_numbers WHERE tenant_id=$1 AND id=$2', [tenantId, String(payload.numberId ?? '')])).rows[0] ?? null;
    if (actionType === 'reassign_callbacks') return { callbackIds: Array.isArray(payload.callbackIds) ? payload.callbackIds.map(String) : [], assignedSdrId: payload.assignedSdrId ?? null };
    return null;
  }

  private async executeAction(tenantId: string, actorUserId: string, actionType: string, payload: Record<string, any>) {
    if (actionType === 'navigate') return { kind: 'navigation', payload };
    if (actionType === 'pause_campaign') {
      const campaignId = String(payload.campaignId ?? '');
      if (!campaignId) throw new ConflictException('Ação sem campanha alvo');
      return this.db.transaction(async (client) => {
        const row = (await client.query('SELECT id, status, lock_version FROM campaigns WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, campaignId])).rows[0];
        if (!row) throw new NotFoundException('Campanha alvo não encontrada');
        if (row.status === 'paused') return { kind: 'no_op', reason: 'already_paused', campaignId };
        if (row.status !== 'running') throw new ConflictException('A campanha não está rodando; a recomendação ficou obsoleta');
        await client.query("UPDATE campaigns SET status='paused', lock_version=lock_version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, campaignId]);
        await this.audit.record({ actorUserId, tenantId, action: 'campaign.paused_by_recommendation', entityType: 'campaign', entityId: campaignId }, client as any);
        return { kind: 'campaign_paused', campaignId };
      });
    }
    if (actionType === 'start_dialer') {
      if (this.schedule) await this.schedule.assertAllowed(tenantId);
      const result = await this.db.query('UPDATE dialer_settings SET running=true WHERE tenant_id=$1 AND running=false RETURNING running', [tenantId]);
      if (!result.rows[0]) return { kind: 'no_op', reason: 'already_running' };
      await this.audit.record({ actorUserId, tenantId, action: 'dialer.started_by_recommendation', entityType: 'dialer' });
      return { kind: 'dialer_started', running: true };
    }
    if (actionType === 'disable_number') {
      const numberId = String(payload.numberId ?? '');
      if (!numberId) throw new ConflictException('Ação sem número alvo');
      const result = await this.db.transaction(async (client) => {
        const number = (await client.query('SELECT id, status, flagged_until FROM whatsapp_numbers WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, numberId])).rows[0];
        if (!number) throw new NotFoundException('Linha alvo não encontrada');
        const active = await client.query("SELECT 1 FROM calls WHERE tenant_id=$1 AND number_id=$2 AND status IN ('reserved','dialing','media_active') LIMIT 1", [tenantId, numberId]);
        if (active.rows[0]) throw new ConflictException('Não é possível proteger uma linha durante uma chamada ativa');
        if (number.flagged_until && new Date(number.flagged_until).getTime() > Date.now()) return { kind: 'no_op', reason: 'already_protected', numberId, flaggedUntil: number.flagged_until };
        const flaggedUntil = new Date(Date.now() + 15 * 60 * 1000);
        await client.query('UPDATE whatsapp_numbers SET flagged_until=$1 WHERE tenant_id=$2 AND id=$3', [flaggedUntil, tenantId, numberId]);
        return { kind: 'number_temporarily_disabled', numberId, flaggedUntil: flaggedUntil.toISOString() };
      });
      await this.audit.record({ actorUserId, tenantId, action: 'recommendation.number_temporarily_disabled', entityType: 'whatsapp_number', entityId: numberId, metadata: result });
      return result;
    }
    if (actionType === 'reassign_callbacks') {
      const callbackIds = Array.isArray(payload.callbackIds) ? payload.callbackIds.map(String).filter(Boolean).slice(0, 100) : [];
      if (!callbackIds.length) throw new ConflictException('Ação sem callbacks alvo');
      const assignedSdrId = payload.assignedSdrId ? String(payload.assignedSdrId) : null;
      const result = await this.db.transaction(async (client) => {
        if (assignedSdrId) {
          const sdr = await client.query(`SELECT 1 FROM sdrs s JOIN tenant_memberships tm ON tm.tenant_id=s.tenant_id AND tm.user_id=s.user_id AND tm.role='sdr' AND tm.status='active' WHERE s.tenant_id=$1 AND s.id=$2`, [tenantId, assignedSdrId]);
          if (!sdr.rows[0]) throw new ConflictException('SDR alvo não encontrado ou inativo');
        }
        const updated = await client.query(`UPDATE lead_callbacks SET assigned_sdr_id=$1, status='reassigned', updated_by_user_id=$2, updated_at=now() WHERE tenant_id=$3 AND id=ANY($4::uuid[]) AND status IN ('pending','due','reassigned') RETURNING id`, [assignedSdrId, actorUserId, tenantId, callbackIds]);
        await this.audit.record({ actorUserId, tenantId, action: 'callback.reassigned_by_recommendation', entityType: 'callback', metadata: { callbackIds, assignedSdrId, updated: updated.rowCount ?? 0 } }, client as any);
        return { kind: 'callbacks_reassigned', updated: updated.rowCount ?? 0, callbackIds };
      });
      return result;
    }
    throw new ConflictException('Ação não catalogada');
  }

  async history(tenantId: string, id?: string, limit = 100) {
    await this.assertEnabled(tenantId);
    return { items: await this.repo.history(tenantId, id, limit) };
  }
}
