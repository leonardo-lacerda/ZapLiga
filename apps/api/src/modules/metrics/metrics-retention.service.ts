import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService } from '../billing/entitlement.service';

const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

export type RetentionCounts = {
  leadStageHistory: number;
  sdrAvailabilityHistory: number;
  numberStatusHistory: number;
  metricsDailyRollup: number;
  metricExports: number;
};

/**
 * "Criar retenção por plano" (plano seção 13, Fase 8, item 4). O projeto não
 * tem sistema de planos/assinatura (tabela `tenants` não tem coluna de
 * plano) — a interpretação honesta, sem inventar billing que não existe, é
 * retenção configurável por tenant (coluna `tenants.metrics_retention_days`,
 * migração 024).
 *
 * Escopo deliberadamente restrito às tabelas de SUPORTE a métricas — nunca
 * `calls`/`leads`, que são dados operacionais centrais, não apenas
 * históricos de métricas. Apagar chamadas/leads é responsabilidade de outra
 * funcionalidade (se um dia existir), não desta.
 *
 * `purge()` nunca roda sozinho — não há agendador/cron neste projeto, e
 * mesmo que houvesse, apagar dados de produção automaticamente é uma
 * decisão que cabe ao usuário, não a esta implementação. É um endpoint
 * disparado manualmente, com `dryRun` por padrão.
 */
@Injectable()
export class MetricsRetentionService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly entitlement: EntitlementService) {}

  async getPolicy(tenantId: string): Promise<{ retentionDays: number | null; source?: 'plan' | 'tenant'; configuredDays?: number | null }> {
    const result = await this.db.query('SELECT metrics_retention_days FROM tenants WHERE id = $1', [tenantId]);
    const access = await this.entitlement.getAccess(tenantId);
    const configured = result.rows[0]?.metrics_retention_days;
    const planLimit = Number(access.limitEntitlements?.retention_days);
    if (access.mode === 'full' && Number.isFinite(planLimit) && planLimit > 0) return { retentionDays: planLimit, source: 'plan' as const, configuredDays: configured == null ? null : Number(configured) };
    return { retentionDays: configured === null || configured === undefined ? null : Number(configured), source: 'tenant' as const };
  }

  async setPolicy(tenantId: string, userId: string, retentionDays: number | null): Promise<{ retentionDays: number | null }> {
    const access = await this.entitlement.getAccess(tenantId);
    const planLimit = Number(access.limitEntitlements?.retention_days);
    if (retentionDays !== null && Number.isFinite(planLimit) && planLimit > 0 && retentionDays > planLimit) throw new BadRequestException(`O plano permite no máximo ${planLimit} dias de retenção`);
    if (retentionDays !== null && (retentionDays < MIN_RETENTION_DAYS || retentionDays > MAX_RETENTION_DAYS)) {
      throw new BadRequestException(`retentionDays deve estar entre ${MIN_RETENTION_DAYS} e ${MAX_RETENTION_DAYS}, ou nulo para manter indefinidamente`);
    }
    await this.db.query('UPDATE tenants SET metrics_retention_days = $2 WHERE id = $1', [tenantId, retentionDays]);
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_retention.policy_updated', entityType: 'tenant', metadata: { retentionDays } });
    return { retentionDays };
  }

  private async countExpired(tenantId: string, cutoff: string): Promise<RetentionCounts> {
    const [leadStage, sdrAvail, numberStatus, rollup, exports] = await Promise.all([
      this.db.query('SELECT count(*)::int AS count FROM lead_stage_history WHERE tenant_id = $1 AND created_at < $2', [tenantId, cutoff]),
      this.db.query('SELECT count(*)::int AS count FROM sdr_availability_history WHERE tenant_id = $1 AND changed_at < $2', [tenantId, cutoff]),
      this.db.query('SELECT count(*)::int AS count FROM number_status_history WHERE tenant_id = $1 AND changed_at < $2', [tenantId, cutoff]),
      this.db.query('SELECT count(*)::int AS count FROM metrics_daily_rollup WHERE tenant_id = $1 AND day < $2::date', [tenantId, cutoff]),
      this.db.query('SELECT count(*)::int AS count FROM metric_exports WHERE tenant_id = $1 AND created_at < $2', [tenantId, cutoff]),
    ]);
    return {
      leadStageHistory: Number(leadStage.rows[0]?.count ?? 0),
      sdrAvailabilityHistory: Number(sdrAvail.rows[0]?.count ?? 0),
      numberStatusHistory: Number(numberStatus.rows[0]?.count ?? 0),
      metricsDailyRollup: Number(rollup.rows[0]?.count ?? 0),
      metricExports: Number(exports.rows[0]?.count ?? 0),
    };
  }

  /** `confirm: false` (padrão) só relata o que seria apagado — nunca apaga. */
  async purge(tenantId: string, userId: string, confirm: boolean): Promise<{ cutoff: string; confirmed: boolean; counts: RetentionCounts }> {
    const policy = await this.getPolicy(tenantId);
    if (policy.retentionDays === null) {
      throw new BadRequestException('Este tenant não tem uma política de retenção definida — configure metrics_retention_days antes de expurgar.');
    }
    const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000).toISOString();
    const counts = await this.countExpired(tenantId, cutoff);

    if (!confirm) return { cutoff, confirmed: false, counts };

    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM lead_stage_history WHERE tenant_id = $1 AND created_at < $2', [tenantId, cutoff]);
      await client.query('DELETE FROM sdr_availability_history WHERE tenant_id = $1 AND changed_at < $2', [tenantId, cutoff]);
      await client.query('DELETE FROM number_status_history WHERE tenant_id = $1 AND changed_at < $2', [tenantId, cutoff]);
      await client.query('DELETE FROM metrics_daily_rollup WHERE tenant_id = $1 AND day < $2::date', [tenantId, cutoff]);
      await client.query('DELETE FROM metric_exports WHERE tenant_id = $1 AND created_at < $2', [tenantId, cutoff]);
    });
    await this.audit.record({ actorUserId: userId, tenantId, action: 'metrics_retention.purged', entityType: 'tenant', metadata: { cutoff, counts } });
    return { cutoff, confirmed: true, counts };
  }
}
