import { useState } from 'react';
import type React from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { DataTable } from '../../components/DataTable';

const metric = (value: unknown) => Number(value ?? 0).toLocaleString('pt-BR');

export function LeadsPage({
  leads, folders, selectedFolderId, selectedFolder, metrics,
  setSelectedFolderId, createFolder, updateFolder, removeFolder, leadForm, setLeadForm,
  createLead, importCsv, importResult, clearFolder, manualCall, resetLead, removeLead,
}: AnyRow) {
  const [newFolderName, setNewFolderName] = useState('');
  const totalLeads = folders.reduce((sum: number, folder: AnyRow) => sum + Number(folder.lead_count ?? 0), 0);
  const activeFolders = folders.filter((folder: AnyRow) => folder.is_active).length;
  const calls = metrics?.calls ?? {};
  const leadCounts = metrics?.leads ?? {};

  const submitFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    await createFolder(name);
    setNewFolderName('');
  };

  const renameFolder = (folder: AnyRow) => {
    const name = window.prompt('Novo nome da pasta', folder.name);
    if (name?.trim() && name.trim() !== folder.name) void updateFolder(folder.id, { name: name.trim() });
  };

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">PROSPECÇÃO</span><h1>Pastas de leads</h1><p>Organize listas diferentes e escolha quais participam da fila de chamadas.</p></div>
      <div className="lead-heading-badges"><Badge tone="info">{metric(totalLeads)} leads</Badge><Badge tone={activeFolders ? 'success' : 'warning'}>{activeFolders} ativas</Badge></div>
    </div>

    <div className="lead-folder-layout">
      <Panel className="lead-folders-panel">
        <SectionHeader title="Suas pastas" description="Ative quantas listas quiser ao mesmo tempo." />
        <form className="folder-create-form" onSubmit={(event) => void submitFolder(event)}>
          <input placeholder="Nome da nova pasta" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} maxLength={80} />
          <Button icon="plus" disabled={!newFolderName.trim()}>Criar</Button>
        </form>
        <div className="folder-list">
          {folders.map((folder: AnyRow) => <article key={folder.id} className={`folder-card ${selectedFolderId === folder.id ? 'selected' : ''}`} onClick={() => setSelectedFolderId(folder.id)}>
            <div className="folder-card-top"><span className={`folder-icon ${folder.is_active ? 'active' : ''}`}><Icon name="users" size={15} /></span><div className="folder-card-title"><strong>{folder.name}</strong><small>{metric(folder.lead_count)} leads · {metric(folder.ready_count)} prontos</small></div><Badge tone={folder.is_active ? 'success' : 'neutral'}>{folder.is_active ? 'Ativa' : 'Pausada'}</Badge></div>
            <div className="folder-card-footer"><span>{metric(folder.active_call_count)} chamadas agora</span><div className="folder-card-actions"><button type="button" className="link-button" onClick={(event) => { event.stopPropagation(); void updateFolder(folder.id, { isActive: !folder.is_active }); }}>{folder.is_active ? 'Desativar' : 'Ativar'}</button><button type="button" className="icon-button" onClick={(event) => { event.stopPropagation(); renameFolder(folder); }} aria-label={`Renomear ${folder.name}`}><Icon name="settings" size={13} /></button><button type="button" className="icon-button danger" onClick={(event) => { event.stopPropagation(); void removeFolder(folder.id, folder.name); }} disabled={Number(folder.lead_count) > 0} title={Number(folder.lead_count) > 0 ? 'A pasta precisa estar vazia' : 'Excluir pasta'}><Icon name="close" size={13} /></button></div></div>
          </article>)}
          {!folders.length && <div className="folder-empty"><Icon name="users" size={20} /><strong>Crie sua primeira pasta</strong><span>Separe suas listas para controlar a operação.</span></div>}
        </div>
      </Panel>

      <div className="lead-folder-content">
        {!selectedFolder && <Panel><div className="folder-empty large"><Icon name="users" size={24} /><strong>Nenhuma pasta selecionada</strong><span>Crie uma pasta ou selecione uma lista ao lado.</span></div></Panel>}
        {selectedFolder && <>
          <Panel className="folder-overview-panel">
            <div className="folder-overview-heading"><div><span className="eyebrow">PASTA SELECIONADA</span><h2>{selectedFolder.name}</h2><p>{selectedFolder.is_active ? 'Esta pasta participa da fila automática.' : 'Esta pasta está pausada e não receberá novas chamadas.'}</p></div><div className="panel-actions"><Badge tone={selectedFolder.is_active ? 'success' : 'neutral'}>{selectedFolder.is_active ? 'Ativa' : 'Pausada'}</Badge><Button variant={selectedFolder.is_active ? 'danger' : 'success'} icon={selectedFolder.is_active ? 'pause' : 'play'} onClick={() => void updateFolder(selectedFolder.id, { isActive: !selectedFolder.is_active })}>{selectedFolder.is_active ? 'Desativar pasta' : 'Ativar pasta'}</Button></div></div>
            <div className="folder-metric-grid"><div><span>Leads</span><strong>{metric(leadCounts.total ?? selectedFolder.lead_count)}</strong><small>{metric(leadCounts.queued)} na fila</small></div><div><span>Tentativas</span><strong>{metric(calls.attempts)}</strong><small>{metric(calls.active)} em andamento</small></div><div><span>Atendidas</span><strong>{metric(calls.answered)}</strong><small>{metric(calls.answer_rate)}% de aproveitamento</small></div><div><span>Concluídas</span><strong>{metric(calls.completed)}</strong><small>{metric(calls.no_answer)} sem resposta</small></div></div>
          </Panel>

          <Panel>
            <SectionHeader title="Adicionar leads" description={`Novos contatos serão colocados em “${selectedFolder.name}”.`} action={<div className="panel-actions"><label className="upload-button"><Icon name="upload" size={15} />Importar CSV<input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCsv(file); event.currentTarget.value = ''; }} /></label><Button variant="danger" icon="close" onClick={() => void clearFolder()} disabled={!Number(selectedFolder.lead_count)}>Limpar pasta</Button></div>} />
            <form className="form-row" onSubmit={createLead}><input placeholder="Nome" value={leadForm.name} onChange={(event) => setLeadForm({ ...leadForm, name: event.target.value })} required /><input placeholder="5511999999999" value={leadForm.phone} onChange={(event) => setLeadForm({ ...leadForm, phone: event.target.value })} required /><Button icon="plus">Adicionar lead</Button></form>
            <small className="form-hint">Aceita name,phone ou exportação do Kommo com Nome completo e campos de telefone.</small>
            {importResult && <div className="import-success"><Icon name="check" size={14} />{importResult}</div>}
          </Panel>

          <DataTable rows={leads} columns={['name', 'phone', 'status', 'attempts', 'last_failure_reason']} actions={(row) => {
            const callInProgress = ['reserved', 'dialing', 'media_active'].includes(String(row.status));
            return <><Button variant="success" onClick={() => void manualCall(row.id, row.name)} disabled={!selectedFolder.is_active || row.do_not_call || !['queued', 'retry_wait'].includes(row.status)} title={!selectedFolder.is_active ? 'Ative a pasta para ligar' : undefined}>Ligar agora</Button><Button variant="ghost" onClick={() => void resetLead(row.id)} disabled={callInProgress} title={callInProgress ? 'Aguarde a chamada terminar para resetar' : 'Zerar tentativas e recolocar na fila'}>Resetar</Button><Button variant="danger" icon="close" onClick={() => void removeLead(row.id, row.name, row.phone)} disabled={callInProgress} title={callInProgress ? 'Aguarde a chamada terminar para remover' : 'Remover somente este lead'}>Remover</Button></>;
          }} />
        </>}
      </div>
    </div>
  </>;
}
