import type { ReactNode } from 'react';
import type { AnyRow } from '../types';
import { Badge, EmptyState } from './ui';
import { formatSeconds, labelStatus } from '../shared/format';
const columnLabels: Record<string, string> = { name: 'Nome', phone: 'Telefone', lead_name: 'Lead', lead_phone: 'Telefone', sdr_name: 'SDR', status: 'Status', outcome: 'Resultado', attempts: 'Tentativas', available: 'Disponibilidade', duration_seconds: 'DuraÃ§Ã£o' };
const statusTone = (value: unknown) => ['connected', 'online', 'ready', 'authenticated', 'completed', 'available'].includes(String(value).toLowerCase()) ? 'success' : ['failed', 'no_answer', 'disconnected'].includes(String(value).toLowerCase()) ? 'error' : ['dialing', 'media_active', 'reserved'].includes(String(value).toLowerCase()) ? 'info' : 'neutral';
export function DataTable({ rows, columns, actions }: { rows: AnyRow[]; columns: string[]; actions?: (row: AnyRow) => ReactNode }) { return <div className="table-container"><div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{columnLabels[column] ?? column}</th>)}{actions && <th>AÃ§Ãµes</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? index}>{columns.map((column) => <td key={column}>{column === 'status' ? <Badge tone={statusTone(row[column])}>{labelStatus(row[column])}</Badge> : column === 'available' ? <Badge tone={row[column] ? 'success' : 'neutral'}>{row[column] ? 'DisponÃ­vel' : 'Offline'}</Badge> : column === 'duration_seconds' ? formatSeconds(row[column]) : String(row[column] ?? 'â€”')}</td>)}{actions && <td><div className="table-actions">{actions(row)}</div></td>}</tr>)}</tbody></table></div>{!rows.length && <EmptyState title="Nada por aqui ainda" description="Os registros aparecerÃ£o nesta tabela quando existirem." />}</div>; }



