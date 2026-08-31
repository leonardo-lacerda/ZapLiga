import { FormEvent, useCallback, useEffect, useState } from 'react';
import { apiFetch, json } from '../../services/api';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { PAGE_SIZE, formatNumber } from '../../shared/format';
import type { AnyRow } from '../../types';

const reasonLabels: Record<string, string> = {
  requested_opt_out: 'Solicitou não receber chamadas',
  invalid_number: 'Número inválido',
  legal_restriction: 'Restrição legal',
  internal_policy: 'Política interna',
  other: 'Outro',
};

export function CompliancePage({ tenantId }: { tenantId: string }) {
  const [items, setItems] = useState<AnyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('requested_opt_out');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (search.trim()) params.set('search', search.trim());
      const result = await json(`/api/tenants/${tenantId}/contact-suppressions?${params}`);
      setItems(result.items ?? []); setTotal(Number(result.total ?? 0));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [tenantId, offset, search]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); }, [tenantId, search]);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await json(`/api/tenants/${tenantId}/contact-suppressions`, { method: 'POST', body: JSON.stringify({ phone, reason, notes: notes.trim() || undefined, source: 'lead_action' }) });
      setPhone(''); setNotes(''); setMessage('Telefone incluído na lista de não contato.'); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const lift = async (item: AnyRow) => {
    const justification = window.prompt(`Justificativa para permitir novas chamadas para ${item.phone}:`);
    if (!justification?.trim()) return;
    try {
      await json(`/api/tenants/${tenantId}/contact-suppressions/${item.id}`, { method: 'DELETE', body: JSON.stringify({ reason: justification.trim() }) });
      setMessage('Supressão retirada com auditoria.'); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const importCsv = async (file: File) => {
    const data = new FormData(); data.append('file', file); setBusy(true); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/contact-suppressions/import`, { method: 'POST', body: data });
      setMessage(`${result.imported} importados · ${result.duplicated} já existentes · ${result.skipped} ignorados`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const exportCsv = async () => {
    setBusy(true); setMessage('');
    try {
      const response = await apiFetch(`/api/tenants/${tenantId}/contact-suppressions/export.csv`);
      if (!response.ok) throw new Error('Não foi possível exportar a lista');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'lista-nao-contato.csv'; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <>
    <div className="page-heading"><div><span className="eyebrow">COMPLIANCE</span><h1>Lista de não contato</h1><p>Telefones desta lista nunca entram em chamadas automáticas ou manuais.</p></div><Badge tone="warning">{formatNumber(total)} bloqueados</Badge></div>
    {message && <div className="alert" role="status"><span>{message}</span><button onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}
    <Panel>
      <SectionHeader title="Adicionar telefone" description="Use esta ação quando o contato solicitar que não seja chamado novamente." />
      <form className="form-row" onSubmit={create}>
        <input type="tel" placeholder="Telefone com DDD" value={phone} onChange={(event) => setPhone(event.target.value)} required />
        <select value={reason} onChange={(event) => setReason(event.target.value)}>{Object.entries(reasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input placeholder="Observação opcional" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
        <Button icon="plus" disabled={busy}>{busy ? 'Salvando…' : 'Bloquear chamadas'}</Button>
      </form>
    </Panel>
    <Panel>
      <SectionHeader title="Telefones bloqueados" description="A retirada exige justificativa e fica registrada na auditoria." action={<div className="panel-actions"><div className="admin-search"><Icon name="search" size={14} /><input placeholder="Buscar telefone" value={search} onChange={(event) => setSearch(event.target.value)} /></div><label className="upload-button"><Icon name="upload" size={15} />Importar CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importCsv(file); event.currentTarget.value = ''; }} /></label><Button variant="secondary" icon="download" disabled={busy || !total} onClick={() => void exportCsv()}>Exportar</Button></div>} />
      <div className="table-scroll"><table><thead><tr><th>Telefone</th><th>Contato</th><th>Motivo</th><th>Origem</th><th>Registrado em</th><th>Ação</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.phone}</strong></td><td>{item.lead_name || '—'}</td><td>{reasonLabels[item.reason] ?? item.reason}</td><td>{item.source}</td><td>{new Date(item.created_at).toLocaleString('pt-BR')}</td><td><Button variant="ghost" onClick={() => void lift(item)}>Permitir novamente</Button></td></tr>)}</tbody></table>{!items.length && <EmptyState title="Nenhum telefone bloqueado" description="Solicitações de não contato aparecerão aqui." />}</div>
      <Pagination offset={offset} limit={PAGE_SIZE} total={total} onChange={setOffset} />
    </Panel>
  </>;
}

