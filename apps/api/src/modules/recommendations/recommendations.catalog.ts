import { MetricsAlert, MetricsAlertSeverity } from '../metrics/metrics.types';
import { Recommendation, RecommendationAction, RecommendationEvidence, RecommendationSeverity } from './recommendations.types';

const severityRank: Record<RecommendationSeverity, number> = { critical: 0, warning: 1, info: 2 };
const actionByCode: Record<string, RecommendationAction> = {
  queue_stalled: { label: 'Verificar operação', description: 'Abra o painel operacional para conferir SDRs e linhas aptas.', type: 'navigate', payload: { tab: 'dashboard' } },
  no_sdr_available: { label: 'Ver equipe', description: 'Confira disponibilidade e conexão da equipe.', type: 'navigate', payload: { tab: 'sdrs' } },
  numbers_in_quarantine: { label: 'Ver linhas', description: 'Inspecione a saúde das linhas e os tempos de quarentena.', type: 'navigate', payload: { tab: 'numbers' } },
  answer_rate_drop: { label: 'Ver métricas', description: 'Compare o período atual com o anterior antes de agir.', type: 'navigate', payload: { tab: 'metrics' } },
  failure_rate_increase: { label: 'Ver métricas', description: 'Inspecione falhas por linha e por período.', type: 'navigate', payload: { tab: 'metrics' } },
  attempts_per_lead_anomaly: { label: 'Revisar discador', description: 'Confira o limite de tentativas e a cadência configurada.', type: 'navigate', payload: { tab: 'settings' } },
  number_failure_concentration: { label: 'Ver linhas', description: 'Abra o detalhe das linhas antes de continuar discando.', type: 'navigate', payload: { tab: 'numbers' } },
  folder_without_eligible_leads: { label: 'Ver leads', description: 'Revise a fila e os critérios de elegibilidade.', type: 'navigate', payload: { tab: 'leads' } },
  pending_wrap_ups: { label: 'Ver chamadas', description: 'Confira os pós-atendimentos que precisam de registro.', type: 'navigate', payload: { tab: 'calls' } },
  goals_behind: { label: 'Ver métricas', description: 'Compare o progresso das metas com o ritmo esperado.', type: 'navigate', payload: { tab: 'metrics' } },
};

function mapSeverity(severity: MetricsAlertSeverity): RecommendationSeverity { return severity; }

function actionFor(alert: MetricsAlert): RecommendationAction {
  return actionByCode[alert.code] ?? { label: 'Ver diagnóstico', description: alert.recommendedAction, type: 'navigate', payload: { tab: 'metrics' } };
}

export function buildRecommendationCandidates(alerts: MetricsAlert[], observedAt: string, sampleSize?: number): Array<Omit<Recommendation, 'id' | 'tenantId' | 'createdAt' | 'updatedAt' | 'status' | 'snoozedUntil'>> {
  return alerts
    .map((alert) => {
      const severity = mapSeverity(alert.severity);
      const evidence: RecommendationEvidence = { summary: alert.evidence, source: 'metrics_summary', observedAt, sampleSize };
      const action = actionFor(alert);
      return {
        campaignId: null,
        code: alert.code,
        scopeKey: 'tenant',
        severity,
        title: alert.title,
        evidence,
        recommendedAction: action,
        confidence: null,
        impactScope: severity === 'critical' ? 'tenant' : 'operation',
        ruleVersion: 1,
        expiresAt: null,
      };
    })
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.code.localeCompare(right.code))
    .slice(0, 3);
}
