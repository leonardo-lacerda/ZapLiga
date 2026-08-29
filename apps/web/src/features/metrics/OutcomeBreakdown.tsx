import { EmptyState, Panel, SectionHeader } from '../../components/ui';
import { formatNumber, formatPercent } from './metrics.format';
import type { MetricsBreakdownItem } from './metrics.types';

function BarList({ items, emptyLabel, onSelect }: { items: MetricsBreakdownItem[]; emptyLabel: string; onSelect: (item: MetricsBreakdownItem) => void }) {
  if (!items.length) return <EmptyState title={emptyLabel} />;
  const max = Math.max(1, ...items.map((item) => item.count));
  return <div className="metrics-breakdown-list">
    {items.map((item) => <button type="button" className="metrics-breakdown-row" key={item.code} onClick={() => onSelect(item)}>
      <span className="metrics-breakdown-label">{item.label}</span>
      <div className="metrics-breakdown-bar"><div className="metrics-breakdown-fill" style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }} /></div>
      <span className="metrics-breakdown-value">{formatNumber(item.count)} · {formatPercent(item.percent)}</span>
    </button>)}
  </div>;
}

export function OutcomeBreakdown({ outcomes, pipeline, onSelectOutcome, onSelectStage }: { outcomes: MetricsBreakdownItem[]; pipeline: MetricsBreakdownItem[]; onSelectOutcome: (item: MetricsBreakdownItem) => void; onSelectStage: (item: MetricsBreakdownItem) => void }) {
  return <div className="dashboard-grid metrics-breakdown-grid">
    <Panel>
      <SectionHeader eyebrow="RESULTADOS" title="Distribuição de resultados" description="Resultado comercial declarado no pós-atendimento. Clique para ver as chamadas." />
      <BarList items={outcomes} emptyLabel="Sem resultados registrados no período" onSelect={onSelectOutcome} />
    </Panel>
    <Panel>
      <SectionHeader eyebrow="ETAPAS" title="Distribuição de etapas" description="Etapa do funil no momento de cada chamada. Clique para ver as chamadas." />
      <BarList items={pipeline} emptyLabel="Sem etapas registradas no período" onSelect={onSelectStage} />
    </Panel>
  </div>;
}
