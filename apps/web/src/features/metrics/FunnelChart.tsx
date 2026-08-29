import { EmptyState, Panel, SectionHeader } from '../../components/ui';
import { formatNumber, formatPercent } from './metrics.format';
import type { MetricsFunnelStage } from './metrics.types';

export function FunnelChart({ stages }: { stages: MetricsFunnelStage[] }) {
  const base = stages[0]?.count ?? 0;

  if (!base) {
    return <Panel>
      <SectionHeader eyebrow="FUNIL" title="Leads e chamadas" />
      <EmptyState title="Sem leads disponíveis no período" description="Ajuste os filtros ou o intervalo de datas." />
    </Panel>;
  }

  return <Panel>
    <SectionHeader eyebrow="FUNIL" title="Leads e chamadas" description="Cada etapa mostra a regra de contagem no texto de apoio." />
    <div className="metrics-funnel" role="img" aria-label="Funil de leads e chamadas, da disponibilidade à conversão">
      {stages.map((stage) => {
        const percent = base ? Math.round((stage.count / base) * 1000) / 10 : 0;
        return <div className="metrics-funnel-row" key={stage.stage} title={stage.rule}>
          <div className="metrics-funnel-label"><strong>{stage.label}</strong><span>{formatNumber(stage.count)} · {formatPercent(percent)}</span></div>
          <div className="metrics-funnel-bar"><div className="metrics-funnel-fill" style={{ width: `${Math.max(2, percent)}%` }} /></div>
          <small>{stage.rule}</small>
        </div>;
      })}
    </div>
    <details className="metrics-alt-table">
      <summary>Ver como tabela</summary>
      <div className="table-container table-scroll">
        <table>
          <thead><tr><th>Etapa</th><th>Quantidade</th><th>% da primeira etapa</th><th>Regra de contagem</th></tr></thead>
          <tbody>{stages.map((stage) => <tr key={stage.stage}><td>{stage.label}</td><td>{formatNumber(stage.count)}</td><td>{formatPercent(base ? Math.round((stage.count / base) * 1000) / 10 : 0)}</td><td>{stage.rule}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  </Panel>;
}
