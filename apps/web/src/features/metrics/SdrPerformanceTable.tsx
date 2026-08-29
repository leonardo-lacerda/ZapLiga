import { Badge, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { labelStatus } from '../../shared/format';
import { ExportCsvButton } from './ExportCsvButton';
import type { MetricsQueryParams } from './metrics.api';
import { formatNumber, formatPercent, formatSecondsShort } from './metrics.format';
import type { MetricsSdrRanking } from './metrics.types';

export function SdrPerformanceTable({ rows, onSelect, exportParams }: { rows: MetricsSdrRanking[]; onSelect: (row: MetricsSdrRanking) => void; exportParams: MetricsQueryParams }) {
  return <Panel>
    <SectionHeader eyebrow="EQUIPE" title="Desempenho por SDR" action={<div className="metrics-section-actions-inline"><Badge>{rows.length} SDR{rows.length === 1 ? '' : 's'}</Badge><ExportCsvButton dataset="sdrs" params={exportParams} /></div>} />
    {!rows.length ? <EmptyState title="Nenhum SDR com atividade no período" /> : <div className="table-container table-scroll">
      <table>
        <thead><tr>
          <th>SDR</th><th>Status</th><th>Chamadas</th><th>Leads únicos</th><th>Atendidas</th><th>Taxa de atendimento</th>
          <th>Duração média</th><th>Tempo conectado</th><th>Resultados positivos</th><th>Avanço de etapa</th><th>Pós-atendimentos</th><th>Taxa de registro</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.sdrId} className="metrics-table-row" onClick={() => onSelect(row)}>
          <td><strong>{row.name}</strong></td>
          <td><Badge tone={row.available ? 'success' : 'neutral'}>{labelStatus(row.status)}</Badge></td>
          <td>{formatNumber(row.callsMade)}</td>
          <td>{formatNumber(row.uniqueLeadsWorked)}</td>
          <td>{formatNumber(row.callsAnswered)}</td>
          <td>{formatPercent(row.answerRate)}</td>
          <td>{formatSecondsShort(row.avgDurationSeconds)}</td>
          <td>{formatSecondsShort(row.connectedSeconds)}</td>
          <td>{formatNumber(row.positiveResults)}</td>
          <td>{formatNumber(row.stageAdvances)}</td>
          <td>{formatNumber(row.wrapUpsCompleted)}</td>
          <td>{formatPercent(row.wrapUpRate)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </Panel>;
}
