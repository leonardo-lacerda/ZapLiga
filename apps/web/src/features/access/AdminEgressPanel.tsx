import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

// Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).

const REFRESH_MS = 10_000;
const TAILSCALE_LINKS = {
  signup: 'https://login.tailscale.com/start',
  policy: 'https://login.tailscale.com/admin/acls/file',
  oauth: 'https://login.tailscale.com/admin/settings/oauth',
};
const pcStatus: Record<string, [string, string]> = {
  online: ['Online', 'success'],
  pc_offline: ['PC sem resposta', 'warning'],
  waiting_install: ['Aguardando instalação', 'info'],
  slot_down: ['Vaga parada na VPS', 'warning'],
};

type Install = { name: string; windows: string; linux: string; expiresInHours: number };

export function AdminEgressPanel() {
  const [settings, setSettings] = useState<AnyRow | null>(null);
  const [pcs, setPcs] = useState<AnyRow>({ items: [], slots: 0 });
  const [editingSettings, setEditingSettings] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [newName, setNewName] = useState('');
  const [install, setInstall] = useState<Install | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    try {
      const nextSettings = await json('/api/admin/egress/settings');
      setSettings(nextSettings);
      if (nextSettings.configured) setPcs(await json('/api/admin/egress/pcs'));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (key: string, action: () => Promise<unknown>, done = '') => {
    setBusy(key); setMessage(''); setSuccess('');
    try { await action(); if (done) setSuccess(done); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const copy = async (value: string, done: string) => { await navigator.clipboard?.writeText(value); setSuccess(done); };

  const saveSettings = (event: React.FormEvent) => {
    event.preventDefault();
    void act('settings', async () => {
      await json('/api/admin/egress/settings', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
      setClientId(''); setClientSecret(''); setEditingSettings(false);
    }, 'Tailscale conectada.');
  };

  const addPc = (event: React.FormEvent) => {
    event.preventDefault();
    void act('add', async () => {
      const result = await json('/api/admin/egress/pcs', { method: 'POST', body: JSON.stringify({ name: newName }) });
      setInstall({ name: result.pc.name, windows: result.windows, linux: result.linux, expiresInHours: result.expiresInHours });
      setNewName('');
    });
  };

  const showInstall = (pc: AnyRow) => void act(`install-${pc.id}`, async () => {
    const result = await json(`/api/admin/egress/pcs/${pc.id}/install-command`, { method: 'POST' });
    setInstall({ name: pc.name, ...result });
  });

  const changeFallback = (pc: AnyRow, fallback: string) => void act(`fallback-${pc.id}`, () => json(`/api/admin/egress/pcs/${pc.id}`, { method: 'PATCH', body: JSON.stringify({ fallback }) }), `${pc.name}: modo salvo. Vale em até 10 segundos.`);

  const removePc = (pc: AnyRow) => {
    if (!window.confirm(`Remover ${pc.name}? Ele sai da Tailscale e a vaga fica livre.`)) return;
    void act(`remove-${pc.id}`, () => json(`/api/admin/egress/pcs/${pc.id}`, { method: 'DELETE' }), `${pc.name} removido.`);
  };

  const notices = <>{message && <div className="alert" role="alert"><Icon name="alert" /><span>{message}</span></div>}{success && <div className="import-success" role="status"><Icon name="check" /><span>{success}</span></div>}</>;

  if (!settings) return <Panel><SectionHeader title="Saídas de internet" />{notices}</Panel>;

  if (!settings.configured || editingSettings) {
    const policy = JSON.stringify(settings.policy, null, 2);
    return <Panel>
      <SectionHeader title="Conectar a Tailscale" description="Uma vez só. Depois disso, cada PC é adicionado com um comando de colar." action={settings.configured ? <Button variant="ghost" onClick={() => setEditingSettings(false)}>Cancelar</Button> : undefined} />
      <ol className="egress-steps">
        <li>Crie uma conta grátis na Tailscale: <a href={TAILSCALE_LINKS.signup} target="_blank" rel="noreferrer">tailscale.com</a>.</li>
        <li>Em <a href={TAILSCALE_LINKS.policy} target="_blank" rel="noreferrer">Access controls</a>, apague o que estiver lá, cole esta política e salve:
          <textarea className="egress-code" readOnly rows={8} value={policy} />
          <Button variant="ghost" type="button" onClick={() => void copy(policy, 'Política copiada.')}>Copiar política</Button>
        </li>
        <li>Em <a href={TAILSCALE_LINKS.oauth} target="_blank" rel="noreferrer">Settings → OAuth clients</a>, crie um client com os escopos <strong>Auth Keys: Write</strong> e <strong>Devices Core: Write</strong>, marcando as tags <code>tag:zapliga-edge</code> e <code>tag:atendente-pc</code>.</li>
        <li>Cole aqui o Client ID e o Client secret:
          <form className="form-row" onSubmit={saveSettings}>
            <input aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} required />
            <input aria-label="Client secret" type="password" placeholder="Client secret" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} required autoComplete="off" />
            <Button disabled={busy === 'settings'}>{busy === 'settings' ? 'Conferindo...' : 'Conectar'}</Button>
          </form>
        </li>
      </ol>
      {notices}
    </Panel>;
  }

  const items = pcs.items as AnyRow[];
  return <>
    <Panel>
      <SectionHeader title="PCs de saída" description={`Os números de um PC saem para a internet pela casa do atendente. ${items.length} de ${pcs.slots} vagas em uso.`} action={<Button variant="ghost" onClick={() => setEditingSettings(true)}>Trocar credenciais da Tailscale</Button>} />
      <form className="form-row" onSubmit={addPc}>
        <input aria-label="Nome do PC" placeholder="Ex.: PC da Ana" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={60} required />
        <Button icon="plus" disabled={busy === 'add' || items.length >= pcs.slots}>{busy === 'add' ? 'Criando...' : 'Adicionar PC'}</Button>
      </form>
      {notices}
      {install && <div className="egress-install">
        <strong>Instalar no {install.name}</strong>
        <ol className="egress-steps">
          <li>No PC, clique com o botão direito no menu Iniciar e abra <strong>Terminal (Admin)</strong>, <strong>PowerShell (Admin)</strong> ou o Prompt de Comando como administrador.</li>
          <li>Cole o comando e aperte Enter:
            <textarea className="egress-code" readOnly rows={4} value={install.windows} />
            <Button variant="ghost" type="button" onClick={() => void copy(install.windows, 'Comando copiado.')}>Copiar comando</Button>
          </li>
          <li>Em até 1 minuto o PC aparece como <strong>Online</strong> aqui embaixo. Deixe o PC ligado.</li>
        </ol>
        <small className="text-muted">O comando vale por {install.expiresInHours} h e funciona uma vez. Linux: <code>{install.linux}</code></small>
        <div className="table-actions"><Button variant="ghost" onClick={() => setInstall(null)}>Fechar</Button></div>
      </div>}
      {items.map((pc) => {
        const [label, tone] = pcStatus[pc.status] ?? [pc.status, 'info'];
        return <div className="admin-compact-row" key={pc.id}>
          <div><strong>{pc.name}</strong><small>{pc.tailscale_ip ?? 'ainda não instalado'} · {pc.number_count} número(s)</small></div>
          <Badge tone={tone}>{label}</Badge>
          <select aria-label="Se o PC desligar" title="Se o PC desligar" value={pc.fallback} disabled={busy === `fallback-${pc.id}`} onChange={(event) => changeFallback(pc, event.target.value)}>
            <option value="offline">PC desligado: números param</option>
            <option value="vps">PC desligado: saem pela VPS</option>
          </select>
          <div className="table-actions">
            <Button variant="ghost" onClick={() => showInstall(pc)} disabled={busy === `install-${pc.id}`}>Comando de instalação</Button>
            <Button variant="danger" onClick={() => removePc(pc)} disabled={busy === `remove-${pc.id}`}>Remover</Button>
          </div>
        </div>;
      })}
      {!items.length && <EmptyState title="Nenhum PC ainda" description="Adicione o PC de um atendente para começar." />}
    </Panel>
    <small className="form-hint">Para um número sair por um PC: Empresas → Detalhes → Números, escolha o PC em “Saída de internet” e leia o QR do número.</small>
  </>;
}
