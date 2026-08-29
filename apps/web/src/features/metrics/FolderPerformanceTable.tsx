import { Badge, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { ExportCsvButton } from './ExportCsvButton';
import type { MetricsQueryParams } from './metrics.api';
import { formatNumber, formatPercent } from './metrics.format';
import type { MetricsFolderRanking } from './metrics.types';

export function FolderPerformanceTable({ rows, onSelect, exportParams }: { rows: MetricsFolderRanking[]; onSelect: (row: MetricsFolderRanking) => void; exportParams: MetricsQueryParams }) {
  return <Panel>
    <SectionHeader eyebrow="PASTAS" title="Desempenho por pasta" action={<div className="metrics-section-actions-inline"><Badge>{rows.length} pasta{rows.length === 1 ? '' : 's'}</Badge><ExportCsvButton dataset="folders" params={exportParams} /></div>} />
    {!rows.length ? <EmptyState title="Nenhuma pasta com atividade no período" /> : <div className="table-container table-scroll">
      <table>
        <thead><tr>
          <th>Pasta</th><th>Leads totais</th><th>Leads trabalhados</th><th>Fila atual</th><th>Chamadas</th><th>Atendimento</th>
          <th>Resultado positivo</th><th>Avanço de etapa</th><th>Conversões</th><th>Melhor horário</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.folderId} className="metrics-table-row" onClick={() => onSelect(row)}>
          <td><strong>{row.name}</strong></td>
          <td>{formatNumber(row.totalLeads)}</td>
          <td>{formatNumber(row.leadsWorked)}</td>
          <td>{formatNumber(row.currentQueue)}</td>
          <td>{formatNumber(row.callsMade)}</td>
          <td>{formatPercent(row.answerRate)}</td>
          <td>{formatNumber(row.positiveResults)}</td>
          <td>{formatNumber(row.stageAdvances)}</td>
          <td>{formatNumber(row.conversions)}</td>
          <td>{row.bestHour === null ? '—' : `${String(row.bestHour).padStart(2, '0')}h`}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </Panel>;
}
