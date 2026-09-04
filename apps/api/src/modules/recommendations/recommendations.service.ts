import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
    const candidates = buildRecommendationCandidates(summary.alerts, summary.freshness.generatedAt, summary.kpis.callsMade.numerator);
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
    if (row.action_type !== 'navigate') throw new ConflictException('Ação operacional será habilitada no próximo lote');
    await this.repo.recordEvent(tenantId, id, 'applied', actorUserId, { actionType: row.action_type });
    return { ok: true, action: row.recommended_action, status: 'applied' };
  }

  async history(tenantId: string, id?: string, limit = 100) {
    await this.assertEnabled(tenantId);
    return { items: await this.repo.history(tenantId, id, limit) };
  }
}
