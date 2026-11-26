import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

// Saída por proxy residencial (docs/saida-por-proxy.md): uma linha numa vaga de proxy sai pelo IP
// da proxy, inclusive o UDP das ligações, e o consumo de rede fica registrado por dia.

const REFRESH_MS = 15_000;
const eventCopy: Record<string, string> = { ip_changed: 'IP de saída mudou', down: 'Proxy caiu', up: 'Proxy voltou' };

export function formatBytes(value: unknown) {
  const bytes = Number(value ?? 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// Projeção do mês: o consumo até hoje dividido pelos dias corridos, vezes os dias do mês.
function monthProjection(monthBytes: unknown) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (Number(monthBytes ?? 0) / now.getDate()) * daysInMonth;
}

export function AdminProxyPanel() {
  const [data, setData] = useState<AnyRow>({ items: [], freeSlots: [] });
  const [name, setName] = useState('');
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try { setData(await json('/api/admin/egress/proxies')); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), REFRESH_MS); return () => clearInterval(timer); }, [load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('add'); setMessage('');
    try {
      await json('/api/admin/egress/proxies', { method: 'POST', body: JSON.stringify({ name, proxy }) });
      setName(''); setProxy('');
      setMessage('Proxy cadastrada. A vaga conecta em até 1 minuto; depois mova a linha para ela em Empresas → Números.');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const remove = async (item: AnyRow) => {
    if (!window.confirm(`Remover a proxy ${item.name}?`)) return;
    setBusy(`remove-${item.id}`); setMessage('');
    try { await json(`/api/admin/egress/proxies/${item.id}`, { method: 'DELETE' }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  return <Panel>
    <SectionHeader title="Proxies" description={`Cada linha numa vaga de proxy sai pelo IP da proxy, inclusive nas ligações. ${data.freeSlots.length} vaga(s) de proxy livre(s).`} />
    {message && <div className="alert" role="status"><Icon name="info" /><span>{message}</span></div>}
    {data.items.map((item: AnyRow) => <div className="admin-compact-row" key={item.id}>
      <div>
        <strong>{item.name}</strong>
        <small>{item.slot} · saída {item.exit_ip ?? '—'} · {item.latency_ms != null ? `${item.latency_ms} ms` : 'latência —'} · {(item.lines ?? []).map((line: AnyRow) => line.label).join(', ') || 'sem linha'}</small>
        <small>Rede hoje {formatBytes(item.today_bytes)} (ligações {formatBytes(item.today_udp_bytes)}) · mês {formatBytes(item.month_bytes)} · projeção do mês {formatBytes(monthProjection(item.month_bytes))}</small>
        {item.last_error && <small>Último erro: {item.last_error}</small>}
        {(item.events ?? []).slice(0, 3).map((event: AnyRow, index: number) => <small key={index}>{new Date(event.occurred_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {eventCopy[event.kind] ?? event.kind}{event.kind === 'ip_changed' ? ` (${event.detail?.from} → ${event.detail?.to})` : ''}</small>)}
      </div>
      <Badge tone={item.online ? 'success' : 'warning'}>{item.online ? 'Online' : 'Sem saída'}</Badge>
      <Badge tone={item.udp_ok ? 'success' : 'warning'}>{item.udp_ok ? 'UDP ok' : 'UDP não passa'}</Badge>
      <div className="table-actions"><Button variant="danger" onClick={() => void remove(item)} disabled={busy === `remove-${item.id}`}>Remover</Button></div>
    </div>)}
    {!data.items.length && <EmptyState title="Nenhuma proxy ainda" description="Cadastre uma proxy SOCKS5 residencial com UDP para dar um IP próprio a uma linha." />}
    {data.freeSlots.length > 0 && <form className="number-create-form" onSubmit={(event) => void add(event)}>
      <label><span>Nome</span><input value={name} maxLength={60} required onChange={(event) => setName(event.target.value)} placeholder="Roundproxies - Previtas 10" /></label>
      <label><span>Proxy (host:porta:usuário:senha ou socks5://…)</span><input value={proxy} required autoComplete="off" onChange={(event) => setProxy(event.target.value)} /></label>
      <Button icon="plus" disabled={busy === 'add'}>Cadastrar proxy</Button>
    </form>}
  </Panel>;
}
