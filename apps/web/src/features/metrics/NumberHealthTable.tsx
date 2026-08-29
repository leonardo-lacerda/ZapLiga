import { Badge, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { labelStatus } from '../../shared/format';
import { ExportCsvButton } from './ExportCsvButton';
import type { MetricsQueryParams } from './metrics.api';
import { formatDateTime, formatNumber, formatPercent, formatRemainingSeconds } from './metrics.format';
import type { MetricsNumberRanking } from './metrics.types';

const CONNECTED_STATUSES = ['connected', 'online', 'ready', 'authenticated'];

export function NumberHealthTable({ rows, onSelect, exportParams }: { rows: MetricsNumberRanking[]; onSelect: (row: MetricsNumberRanking) => void; exportParams: MetricsQueryParams }) {
  return <Panel>
    <SectionHeader eyebrow="NÚMEROS" title="Saúde dos números" action={<div className="metrics-section-actions-inline"><Badge>{rows.length} número{rows.length === 1 ? '' : 's'}</Badge><ExportCsvButton dataset="numbers" params={exportParams} /></div>} />
    {!rows.length ? <EmptyState title="Nenhum número cadastrado" /> : <div className="table-container table-scroll">
      <table>
        <thead><tr>
          <th>Número</th><th>Status</th><th>Chamadas</th><th>Atendimento</th><th>Falhas</th><th>Simultâneas</th>
          <th>Utilização</th><th>Cooldown</th><th>Quarentena</th><th>Última atividade</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.numberId} className="metrics-table-row" onClick={() => onSelect(row)}>
          <td><strong>{row.label}</strong></td>
          <td><Badge tone={CONNECTED_STATUSES.includes(row.status) ? 'success' : 'neutral'}>{labelStatus(row.status)}</Badge></td>
          <td>{formatNumber(row.callsMade)}</td>
          <td>{formatPercent(row.answerRate)}</td>
          <td>{formatNumber(row.failed)}</td>
          <td>{row.activeCalls}/{row.maxConcurrentCalls}</td>
          <td>{formatPercent(row.utilization)}</td>
          <td>{formatRemainingSeconds(row.cooldownRemainingSeconds)}</td>
          <td>{row.quarantineRemainingSeconds > 0 ? formatRemainingSeconds(row.quarantineRemainingSeconds) : 'Livre'}</td>
          <td>{formatDateTime(row.lastActivityAt)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </Panel>;
}
