import type { AnyRow } from '../../types';
import { Badge, Pagination } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { PAGE_SIZE, formatNumber } from '../../shared/format';

export function CallsPage({ calls, callsTotal, callsOffset, onCallsPageChange }: { calls: AnyRow[]; callsTotal: number; callsOffset: number; onCallsPageChange: (offset: number) => void }) {
  return <><div className="page-heading"><div><span className="eyebrow">ATIVIDADE</span><h1>Histórico de chamadas</h1><p>Consulte os contatos, duração e resultados recentes da operação.</p></div><Badge>{formatNumber(callsTotal)} registros</Badge></div><DataTable rows={calls} columns={['lead_name', 'lead_phone', 'sdr_name', 'status', 'call_result', 'pipeline_stage', 'notes', 'failure_reason', 'duration_seconds']} /><Pagination offset={callsOffset} limit={PAGE_SIZE} total={callsTotal} onChange={onCallsPageChange} /></>;
}
