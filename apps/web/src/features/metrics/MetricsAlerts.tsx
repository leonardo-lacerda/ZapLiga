import { Icon, Panel, SectionHeader } from '../../components/ui';
import type { MetricsAlert, MetricsAlertSeverity } from './metrics.types';

const SEVERITY_LABEL: Record<MetricsAlertSeverity, string> = { critical: 'Crítico', warning: 'Atenção', info: 'Informativo' };
const SEVERITY_ICON: Record<MetricsAlertSeverity, string> = { critical: 'alert', warning: 'alert', info: 'sparkles' };

export function MetricsAlerts({ alerts }: { alerts: MetricsAlert[] }) {
  if (!alerts.length) return null;
  return <Panel>
    <SectionHeader eyebrow="DIAGNÓSTICO" title="Alertas" description="Baseados em regras sobre o período selecionado — evidência e ação sugerida, nunca uma causa confirmada." />
    <div className="metrics-alerts-list">
      {alerts.map((alert) => <div className={`metrics-alert metrics-alert-${alert.severity}`} key={alert.id}>
        <span className="metrics-alert-icon"><Icon name={SEVERITY_ICON[alert.severity]} size={16} /></span>
        <div className="metrics-alert-body">
          <div className="metrics-alert-top"><strong>{alert.title}</strong><span className={`metrics-alert-severity metrics-alert-severity-${alert.severity}`}>{SEVERITY_LABEL[alert.severity]}</span></div>
          <p className="metrics-alert-evidence">{alert.evidence}</p>
          <p className="metrics-alert-action"><strong>Possível ação:</strong> {alert.recommendedAction}</p>
        </div>
      </div>)}
    </div>
  </Panel>;
}
