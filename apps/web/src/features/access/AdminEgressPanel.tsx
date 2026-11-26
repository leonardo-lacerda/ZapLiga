import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import { AdminProxyPanel } from './AdminProxyPanel';

// Internet exit through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).

const REFRESH_MS = 10_000;
const TAILSCALE_LINKS = {
  signup: 'https://login.tailscale.com/start',
  policy: 'https://login.tailscale.com/admin/acls/file',
  credentials: 'https://login.tailscale.com/admin/settings/trust-credentials',
};
const pcStatus: Record<string, [string, string]> = {
  online: ['Online', 'success'],
  pc_offline: ['PC sem resposta', 'warning'],
  slot_down: ['Vaga parada na VPS', 'warning'],
  no_slot: ['Sem vaga livre', 'info'],
};

type Install = { windows: string; linux: string };

export function AdminEgressPanel() {
  const [settings, setSettings] = useState<AnyRow | null>(null);
  const [pcs, setPcs] = useState<AnyRow>({ items: [], slots: 0, vpsNumbers: 0 });
  const [editingSettings, setEditingSettings] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [pool, setPool] = useState<AnyRow | null>(null);
  const [install, setInstall] = useState<Install | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    try {
      const nextSettings = await json('/api/admin/egress/settings');
      setSettings(nextSettings);
      setPool((current: AnyRow | null) => current ?? { poolEnabled: nextSettings.poolEnabled, maxNumbersPerPc: nextSettings.maxNumbersPerPc, graceMinutes: Math.round(nextSettings.offlineGraceSeconds / 60) });
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

  const savePool = (event: React.FormEvent) => {
    event.preventDefault();
    if (!pool) return;
    void act('pool', () => json('/api/admin/egress/settings/pool', { method: 'PATCH', body: JSON.stringify({ poolEnabled: pool.poolEnabled, maxNumbersPerPc: Number(pool.maxNumbersPerPc), offlineGraceSeconds: Number(pool.graceMinutes) * 60 }) }), 'Distribuição salva. Vale na próxima rodada, em até 30 segundos.');
  };

  const showInstall = () => void act('install', async () => setInstall(await json('/api/admin/egress/install-command')));

  const removePc = (pc: AnyRow) => {
    if (!window.confirm(`Remover ${pc.name}? Os números dele passam para o PC online com menos números, sem pedir QR, e o PC sai da Tailscale.`)) return;
    void act(`remove-${pc.id}`, () => json(`/api/admin/egress/pcs/${pc.id}`, { method: 'DELETE' }), `${pc.name} removido.`);
  };

  const notices = <>{message && <div className="alert" role="alert"><Icon name="alert" /><span>{message}</span></div>}{success && <div className="import-success" role="status"><Icon name="check" /><span>{success}</span></div>}</>;

  if (!settings) return <Panel><SectionHeader title="Saídas de internet" />{notices}</Panel>;

  if (!settings.configured || editingSettings) {
    const policy = JSON.stringify(settings.policy, null, 2);
    return <Panel>
      <SectionHeader title="Conectar a Tailscale" description="Uma vez só. Depois disso, cada PC entra com um comando de colar." action={settings.configured ? <Button variant="ghost" onClick={() => setEditingSettings(false)}>Cancelar</Button> : undefined} />
      <ol className="egress-steps">
        <li>Crie uma conta grátis na Tailscale: <a href={TAILSCALE_LINKS.signup} target="_blank" rel="noreferrer">tailscale.com</a>.</li>
        <li>Em <a href={TAILSCALE_LINKS.policy} target="_blank" rel="noreferrer">Access controls</a>, apague o que estiver lá, cole esta política e salve:
          <textarea className="egress-code" readOnly rows={8} value={policy} />
          <Button variant="ghost" type="button" onClick={() => void copy(policy, 'Política copiada.')}>Copiar política</Button>
        </li>
        <li>Em <a href={TAILSCALE_LINKS.credentials} target="_blank" rel="noreferrer">Settings → Trust credentials</a>, crie uma credencial OAuth com os escopos <strong>Auth Keys: Write</strong> e <strong>Devices Core: Write</strong>, marcando as tags <code>tag:zapliga-edge</code> e <code>tag:atendente-pc</code>.</li>
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
  const used = items.filter((pc) => pc.slot).length;
  return <>
    <Panel>
      <SectionHeader title="Instalar num PC" description="O mesmo comando para todos os PCs. O PC aparece na lista sozinho e passa a receber números." action={<Button variant="ghost" onClick={() => setEditingSettings(true)}>Trocar credenciais da Tailscale</Button>} />
      {!install ? <Button icon="plus" onClick={showInstall} disabled={busy === 'install'}>{busy === 'install' ? 'Gerando...' : 'Mostrar comando de instalação'}</Button> : <div className="egress-install">
        <ol className="egress-steps">
          <li>No PC do atendente, clique com o botão direito no menu Iniciar e abra <strong>Terminal (Admin)</strong>, <strong>PowerShell (Admin)</strong> ou o Prompt de Comando como administrador.</li>
          <li>Cole o comando e aperte Enter:
            <textarea className="egress-code" readOnly rows={4} value={install.windows} />
            <Button variant="ghost" type="button" onClick={() => void copy(install.windows, 'Comando copiado.')}>Copiar comando</Button>
          </li>
          <li>Em até 1 minuto o PC aparece abaixo como <strong>Online</strong>. Deixe-o ligado.</li>
        </ol>
        <small className="text-muted">Guarde o comando só com quem instala: ele coloca qualquer PC na rede. Linux: <code>{install.linux}</code></small>
        <div className="table-actions"><Button variant="ghost" onClick={() => setInstall(null)}>Fechar</Button></div>
      </div>}
      {notices}
    </Panel>
    {pool && <Panel>
      <SectionHeader title="Distribuição automática" description="Conecte o número em Números: ele já nasce no PC online com menos números. A plataforma também leva para um PC os números que estão na VPS e tira os números de um PC que fica fora, sem pedir QR de novo." />
      <form className="form-row" onSubmit={savePool}>
        <label className="admin-inline-checkbox"><input type="checkbox" checked={Boolean(pool.poolEnabled)} onChange={(event) => setPool({ ...pool, poolEnabled: event.target.checked })} /> Distribuir sozinho</label>
        <label>Números por PC <input type="number" min={1} max={50} value={pool.maxNumbersPerPc} onChange={(event) => setPool({ ...pool, maxNumbersPerPc: event.target.value })} aria-label="Números por PC" /></label>
        <label>Tirar números de um PC fora há (min) <input type="number" min={1} max={1440} value={pool.graceMinutes} onChange={(event) => setPool({ ...pool, graceMinutes: event.target.value })} aria-label="Minutos fora antes de tirar os números" /></label>
        <Button disabled={busy === 'pool'}>{busy === 'pool' ? 'Salvando...' : 'Salvar'}</Button>
      </form>
    </Panel>}
    <Panel>
      <SectionHeader title="PCs" description={`${used} de ${pcs.slots} vagas em uso · ${pcs.vpsNumbers} número(s) saindo pela VPS.`} />
      {items.map((pc) => {
        const [label, tone] = pcStatus[pc.status] ?? [pc.status, 'info'];
        return <div className="admin-compact-row" key={pc.id}>
          <div><strong>{pc.name}</strong><small>{pc.tailscale_ip ?? '—'} · {pc.number_count} número(s)</small></div>
          <Badge tone={tone}>{label}</Badge>
          <div className="table-actions"><Button variant="danger" onClick={() => removePc(pc)} disabled={busy === `remove-${pc.id}`}>Remover</Button></div>
        </div>;
      })}
      {!items.length && <EmptyState title="Nenhum PC ainda" description="Rode o comando de instalação no PC de um atendente." />}
    </Panel>
    <AdminProxyPanel />
  </>;
}
