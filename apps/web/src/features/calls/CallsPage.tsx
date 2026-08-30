import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { PAGE_SIZE, callResultOptions, callStatusOptions, formatNumber } from '../../shared/format';

export function CallsPage({
  calls, callsTotal, callsOffset, onCallsPageChange,
  search, onSearchChange, status, onStatusChange, result, onResultChange,
}: {
  calls: AnyRow[]; callsTotal: number; callsOffset: number; onCallsPageChange: (offset: number) => void;
  search: string; onSearchChange: (value: string) => void;
  status: string; onStatusChange: (value: string) => void;
  result: string; onResultChange: (value: string) => void;
}) {
  const hasFilters = Boolean(search || status || result);
  const clearFilters = () => { onSearchChange(''); onStatusChange(''); onResultChange(''); };

  return <>
    <div className="page-heading"><div><span className="eyebrow">ATIVIDADE</span><h1>Histórico de chamadas</h1><p>Consulte os contatos, duração e resultados recentes da operação.</p></div><Badge>{formatNumber(callsTotal)} registros</Badge></div>
    <Panel>
      <SectionHeader title="Chamadas" description="Busque por lead, telefone ou SDR e filtre por status e resultado." action={<div className="admin-filters">
        <div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar chamadas" placeholder="Lead, telefone ou SDR" value={search} onChange={(event) => onSearchChange(event.target.value)} /></div>
        <select aria-label="Filtrar por status" value={status} onChange={(event) => onStatusChange(event.target.value)}><option value="">Todos os status</option>{callStatusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="Filtrar por resultado" value={result} onChange={(event) => onResultChange(event.target.value)}><option value="">Todos os resultados</option>{callResultOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {hasFilters && <Button variant="ghost" icon="close" onClick={clearFilters}>Limpar</Button>}
      </div>} />
      <DataTable rows={calls} columns={['lead_name', 'lead_phone', 'sdr_name', 'status', 'call_result', 'pipeline_stage', 'notes', 'failure_reason', 'duration_seconds']} />
      <Pagination offset={callsOffset} limit={PAGE_SIZE} total={callsTotal} onChange={onCallsPageChange} />
    </Panel>
  </>;
}
