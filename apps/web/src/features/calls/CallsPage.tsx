import type { AnyRow } from '../../types';
import { Badge } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function CallsPage({ calls }: { calls: AnyRow[] }) {
  return <><div className="page-heading"><div><span className="eyebrow">ATIVIDADE</span><h1>Histórico de chamadas</h1><p>Consulte os contatos, duração e resultados recentes da operação.</p></div><Badge>{calls.length} registros</Badge></div><DataTable rows={calls} columns={['lead_name', 'lead_phone', 'sdr_name', 'status', 'call_result', 'pipeline_stage', 'notes', 'failure_reason', 'duration_seconds']} /></>;
}
