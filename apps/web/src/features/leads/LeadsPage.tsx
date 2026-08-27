import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

export function LeadsPage({ leads, leadForm, setLeadForm, createLead, importCsv, importResult, clearLeads, manualCall, resetLead, removeLead }: AnyRow) {
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">PROSPECÇÃO</span><h1>Leads</h1><p>Organize os contatos autorizados que entrarão na fila de chamadas.</p></div>
      <Badge tone="info">{leads.length} contatos</Badge>
    </div>
    <Panel>
      <SectionHeader title="Novo lead" description="Cadastre um contato ou importe uma lista CSV do Kommo." action={<div className="panel-actions"><label className="upload-button"><Icon name="upload" size={15} />Importar CSV<input type="file" accept=".csv,text/csv" onChange={(e) => void importCsv(e)} /></label><Button variant="danger" icon="close" onClick={() => void clearLeads()} disabled={!leads.length}>Limpar contatos</Button></div>} />
      <form className="form-row" onSubmit={createLead}><input placeholder="Nome" value={leadForm.name} onChange={(e) => setLeadForm({ ...leadForm, name: e.target.value })} required /><input placeholder="5511999999999" value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} required /><Button icon="plus">Adicionar lead</Button></form>
      <small className="form-hint">Aceita name,phone ou exportação do Kommo com Nome completo e campos de telefone.</small>
      {importResult && <div className="import-success"><Icon name="check" size={14} />{importResult}</div>}
    </Panel>
    <DataTable rows={leads} columns={['name', 'phone', 'status', 'attempts', 'last_failure_reason']} actions={(row) => {
      const callInProgress = ['reserved', 'dialing', 'media_active'].includes(String(row.status));
      return <><Button variant="success" onClick={() => void manualCall(row.id, row.name)} disabled={row.do_not_call || !['queued', 'retry_wait'].includes(row.status)}>Ligar agora</Button><Button variant="ghost" onClick={() => void resetLead(row.id)} disabled={callInProgress} title={callInProgress ? 'Aguarde a chamada terminar para resetar' : 'Zerar tentativas e recolocar na fila'}>Resetar</Button><Button variant="danger" icon="close" onClick={() => void removeLead(row.id, row.name, row.phone)} disabled={callInProgress} title={callInProgress ? 'Aguarde a chamada terminar para remover' : 'Remover somente este lead'}>Remover</Button></>;
    }} />
  </>;
}
