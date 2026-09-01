import { Icon } from '../../components/ui';
import { formatNumber, formatPercent, formatSecondsShort } from './metrics.format';
import type { MetricsKpis, MetricValue } from './metrics.types';

type KpiFormat = 'number' | 'percent' | 'duration';

const KPI_DEFS: { key: keyof MetricsKpis; label: string; icon: string; tone: string; format: KpiFormat; detail: string }[] = [
  { key: 'callsMade', label: 'Chamadas realizadas', icon: 'phone', tone: 'blue', format: 'number', detail: 'Automáticas e manuais, no período' },
  { key: 'uniqueLeadsWorked', label: 'Leads únicos trabalhados', icon: 'users', tone: 'purple', format: 'number', detail: 'Pessoas distintas, não tentativas' },
  { key: 'callsAnswered', label: 'Chamadas atendidas', icon: 'check', tone: 'green', format: 'number', detail: 'Conexão registrada' },
  { key: 'answerRate', label: 'Taxa de atendimento', icon: 'chart', tone: 'blue', format: 'percent', detail: 'Atendidas ÷ realizadas' },
  { key: 'connectedSeconds', label: 'Tempo conectado', icon: 'headset', tone: 'purple', format: 'duration', detail: 'Soma do tempo de conversa' },
  { key: 'avgDurationSeconds', label: 'Duração média', icon: 'history', tone: 'orange', format: 'duration', detail: 'Tempo conectado ÷ atendidas' },
  { key: 'positiveResults', label: 'Resultados positivos', icon: 'sparkles', tone: 'green', format: 'number', detail: 'Inclui conversões' },
  { key: 'wrapUpRate', label: 'Taxa de pós-atendimento', icon: 'check', tone: 'blue', format: 'percent', detail: 'Atendidas com registro concluído' },
  { key: 'activeSdrs', label: 'SDRs ativos', icon: 'headset', tone: 'purple', format: 'number', detail: 'Fizeram ao menos 1 chamada' },
  { key: 'leadsInQueue', label: 'Leads na fila', icon: 'users', tone: 'orange', format: 'number', detail: 'Retrato do momento, sem comparação' },
];

export const PRIMARY_KPI_KEYS: (keyof MetricsKpis)[] = ['callsMade', 'uniqueLeadsWorked', 'answerRate', 'positiveResults', 'connectedSeconds'];
export const SECONDARY_KPI_KEYS: (keyof MetricsKpis)[] = ['callsAnswered', 'avgDurationSeconds', 'wrapUpRate', 'activeSdrs', 'leadsInQueue'];

function formatValue(value: number, format: KpiFormat) {
  if (format === 'percent') return formatPercent(value);
  if (format === 'duration') return formatSecondsShort(value);
  return formatNumber(value);
}

function TrendTag({ metric }: { metric: MetricValue }) {
  if (metric.changePercent === null) return <span className="metrics-trend metrics-trend-flat">sem comparação</span>;
  if (metric.changePercent > 0) return <span className="metrics-trend metrics-trend-up" aria-label={`alta de ${metric.changePercent}%`}>▲ {metric.changePercent}%</span>;
  if (metric.changePercent < 0) return <span className="metrics-trend metrics-trend-down" aria-label={`queda de ${Math.abs(metric.changePercent)}%`}>▼ {Math.abs(metric.changePercent)}%</span>;
  return <span className="metrics-trend metrics-trend-flat">estável</span>;
}

export function MetricsKpiGrid({ kpis, keys = PRIMARY_KPI_KEYS }: { kpis: MetricsKpis; keys?: (keyof MetricsKpis)[] }) {
  return <div className="metric-grid metrics-kpi-grid">
    {KPI_DEFS.filter((def) => keys.includes(def.key)).map((def) => {
      const metric = kpis[def.key];
      return <div className="metric-card metrics-kpi-card" key={def.key}>
        <div className={`metric-icon metric-${def.tone}`}><Icon name={def.icon} size={17} /></div>
        <span>{def.label}</span>
        <strong>{formatValue(metric.value, def.format)}</strong>
        <div className="metrics-kpi-footer">
          <TrendTag metric={metric} />
          {metric.numerator !== undefined && metric.denominator !== undefined && <small>{formatNumber(metric.numerator)} de {formatNumber(metric.denominator)}</small>}
        </div>
        <small>{def.detail}</small>
      </div>;
    })}
  </div>;
}
