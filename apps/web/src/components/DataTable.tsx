import type { ReactNode } from 'react';
import type { AnyRow } from '../types';
import { Badge, EmptyState } from './ui';
import { formatCallReason, labelStatus } from '../shared/format';
import { formatDuration } from './LiveTimer';

const columnLabels: Record<string, string> = {
  name: 'Nome', phone: 'Telefone', lead_name: 'Lead', lead_phone: 'Telefone', sdr_name: 'SDR', status: 'Status', state: 'Estado',
  outcome: 'Resultado técnico', call_result: 'Resultado', pipeline_stage: 'Etapa', lead_pipeline_stage: 'Etapa atual', notes: 'Anotação',
  failure_reason: 'Motivo', last_failure_reason: 'Motivo da última tentativa', attempts: 'Tentativas', available: 'Disponibilidade', duration_seconds: 'Duração',
};
const statusTone = (value: unknown) => ['connected', 'online', 'ready', 'authenticated', 'completed', 'available'].includes(String(value).toLowerCase()) ? 'success' : ['failed', 'no_answer', 'disconnected'].includes(String(value).toLowerCase()) ? 'error' : ['dialing', 'media_active', 'reserved', 'post_call'].includes(String(value).toLowerCase()) ? 'info' : 'neutral';

export function DataTable({ rows, columns, actions }: { rows: AnyRow[]; columns: string[]; actions?: (row: AnyRow) => ReactNode }) {
  return <div className="table-container"><div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{columnLabels[column] ?? column}</th>)}{actions && <th>Ações</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? index}>{columns.map((column) => <td key={column}>{['status', 'state'].includes(column) ? <Badge tone={statusTone(row[column])}>{labelStatus(row[column])}</Badge> : column === 'available' ? <Badge tone={row[column] ? 'success' : 'neutral'}>{row[column] ? 'Disponível' : 'Offline'}</Badge> : column === 'duration_seconds' ? formatDuration(row[column]) : ['outcome', 'failure_reason', 'last_failure_reason'].includes(column) ? formatCallReason(row[column]) : String(row[column] ?? '—')}</td>)}{actions && <td><div className="table-actions">{actions(row)}</div></td>}</tr>)}</tbody></table></div>{!rows.length && <EmptyState title="Nada por aqui ainda" description="Os registros aparecerão nesta tabela quando existirem." />}</div>;
}
