import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { AudioBridge } from '../audio/AudioBridge';
import { apiFetch, json, wsUrl } from '../services/api';
import type { AnyRow, TabKey } from '../types';
import { Badge, Button, Icon } from '../components/ui';
import { LiveTimer } from '../components/LiveTimer';
import { Dashboard } from '../features/dashboard/Dashboard';
import { NumbersPage } from '../features/numbers/NumbersPage';
import { LeadsPage } from '../features/leads/LeadsPage';
import { SdrsPage } from '../features/sdrs/SdrsPage';
import { CallsPage } from '../features/calls/CallsPage';
import { PostCallPanel } from '../features/calls/PostCallPanel';
import { AccessPage } from '../features/access/AccessPage';
import { AdminPage } from '../features/access/AdminPage';
import { AcceptInvitePage } from '../features/auth/AcceptInvitePage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { useAuth } from '../features/auth/AuthProvider';

const pauseFromSdr = (sdr: AnyRow) => sdr?.current_pause_id && sdr.pause_started_at ? ({ id: sdr.current_pause_id, pause_type: sdr.pause_type ?? 'post_call', started_at: sdr.pause_started_at, call_id: sdr.pause_call_id, lead_name: sdr.pause_lead_name, lead_phone: sdr.pause_lead_phone, call_started_at: sdr.pause_call_started_at, pause_elapsed_seconds: sdr.pause_elapsed_seconds }) : null;

function AuthenticatedApp() {
  const { session, activeTenantId, logout, reload } = useAuth();
  const apiBaseUrl = '';
  const fetch = apiFetch;
  const [status, setStatus] = useState<AnyRow>({});
  const [numbers, setNumbers] = useState<AnyRow[]>([]);
  const [leads, setLeads] = useState<AnyRow[]>([]);
  const [sdrs, setSdrs] = useState<AnyRow[]>([]);
  const [calls, setCalls] = useState<AnyRow[]>([]);
  const [logs, setLogs] = useState<AnyRow[]>([]);
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [error, setError] = useState('');
  const [importResult, setImportResult] = useState('');
  const [qr, setQr] = useState<any>(null);
  const [qrNumberId, setQrNumberId] = useState('');
  const [numberForm, setNumberForm] = useState({ label: '', phone: '' });
  const [leadForm, setLeadForm] = useState({ name: '', phone: '' });
  const [selectedSdr, setSelectedSdr] = useState('');
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sdrReady, setSdrReady] = useState(false);
  const [activeCall, setActiveCall] = useState<AnyRow | null>(null);
  const [postCall, setPostCall] = useState<AnyRow | null>(null);
  const [finishingPause, setFinishingPause] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const qrBusy = useRef(false);
  const control = useRef<WebSocket>();
  const audio = useRef(new AudioBridge());
  const audioCall = useRef('');
  const activeTenant = session?.tenants.find((tenant) => tenant.id === activeTenantId);
  const isSdr = activeTenant?.role === 'sdr';
  const isSuperAdmin = session?.user.platformRole === 'super_admin';

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextNumbers, nextLeads, nextSdrs, nextCalls, events] = isSdr
        ? [await json('/api/dialer/sdr-status'), [], [], [await json('/api/me/sdr')], [], []]
        : await Promise.all([json('/api/dialer/status'), json('/api/numbers'), json('/api/leads'), json('/api/sdrs'), json('/api/calls'), json('/api/dialer/logs')]);
      setStatus(nextStatus); setNumbers(nextNumbers); setLeads(nextLeads); setSdrs(nextSdrs); setCalls(nextCalls); setLogs(events); setError('');
      const ownSdr = nextSdrs.find((item: AnyRow) => item.id === selectedSdr);
      const currentPause = ownSdr ? pauseFromSdr(ownSdr) : null;
      if (currentPause && !postCall) setPostCall(currentPause);
    } catch (e) {
      setError(e instanceof TypeError ? 'API temporariamente indisponível. Tentando reconectar...' : String(e));
    }
  }, [selectedSdr, postCall, activeTenantId, isSdr]);

  useEffect(() => { if (!selectedSdr && sdrs[0]?.id) setSelectedSdr(sdrs[0].id); }, [selectedSdr, sdrs]);
  useEffect(() => { setSelectedSdr(''); setActiveCall(null); setPostCall(null); setQr(null); setQrNumberId(''); }, [activeTenantId]);
  useEffect(() => { if (isSdr && tab !== 'dashboard') setTab('dashboard'); }, [isSdr, tab]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    if (!qrNumberId) return;
    let closed = false;
    const refresh = async () => { if (qrBusy.current) return; qrBusy.current = true; try { const next = await json(`/api/numbers/${qrNumberId}/qr`); if (!closed) setQr(next); } catch { /* mantém o último QR válido */ } finally { qrBusy.current = false; } };
    const timer = setInterval(() => void refresh(), 15000);
    return () => { closed = true; clearInterval(timer); };
  }, [qrNumberId]);

  const disconnect = () => { setAvailable(false); setConnected(false); setSdrReady(false); void audio.current.stop(); control.current?.close(); control.current = undefined; };
  const startAudio = (socket: WebSocket, callId: string) => {
    if (audioCall.current === callId) return;
    audioCall.current = callId;
    void audio.current.start(socket).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Áudio do SDR: ${message}`);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'outcome', callId, outcome: `audio_error:${message.slice(0, 120)}` }));
    });
  };

  const connectSdr = async () => {
    setError('');
    if (!selectedSdr) return setError('Selecione ou cadastre um SDR');
    const sdr = sdrs.find((item) => item.id === selectedSdr);
    if (!sdr) return;
    disconnect();
    const ticketResult = await json('/api/auth/ws-ticket');
    const socket = new WebSocket(`${wsUrl()}/ws/tenants/${encodeURIComponent(activeTenantId)}/sdr?ticket=${encodeURIComponent(ticketResult.ticket)}`);
    control.current = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { setConnected(true); socket.send(JSON.stringify({ type: 'identify', sdrId: sdr.id })); };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') { audio.current.play(event.data); return; }
      const message = JSON.parse(event.data);
      if (message.type === 'identified') { setSdrReady(true); setAvailable(Boolean(message.sdr?.available)); const pause = pauseFromSdr(message.sdr); if (pause) setPostCall(pause); }
      if (message.type === 'availability_changed') setAvailable(Boolean(message.available));
      if (message.type === 'sdr_state_changed' && message.sdrId === selectedSdr) setAvailable(Boolean(message.available));
      if (message.type === 'dialer_log') setLogs((current) => [message.log, ...current].slice(0, 100));
      if (message.type === 'call_reserved') setAvailable(false);
      if (message.type === 'call_started' && message.lead?.name) { setAvailable(false); setActiveCall(message); startAudio(socket, message.callId); }
      if (message.type === 'media_open') { setActiveCall((current) => current ? { ...current, mediaOpen: true } : current); startAudio(socket, message.callId); }
      if (message.type === 'media_active') setActiveCall((current) => current ? { ...current, mediaActive: true } : current);
      if (message.type === 'call_finished') { if (audioCall.current === message.callId) audioCall.current = ''; setActiveCall(null); void audio.current.stop(); if (message.pause) { setPostCall(message.pause); setAvailable(false); } else setAvailable(true); void load(); }
      if (message.type === 'pause_finished') { setPostCall(null); setAvailable(true); void load(); }
      if (message.type === 'error') setError(message.message);
    };
    socket.onclose = () => { audioCall.current = ''; setAvailable(false); setConnected(false); setSdrReady(false); void audio.current.stop(); setActiveCall(null); };
  };

  const setAvailability = async (value: boolean) => {
    if (!connected || !sdrReady || control.current?.readyState !== WebSocket.OPEN) return;
    if (value) { if (postCall) { setError('Finalize o pós-atendimento antes de ficar disponível.'); return; } try { await audio.current.prepare(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return; } } else await audio.current.stop();
    control.current?.send(JSON.stringify({ type: 'availability', available: value }));
  };
  const finishPostCall = async (input: AnyRow) => { if (!selectedSdr || !postCall?.id) return; setFinishingPause(true); setError(''); try { await json(`/api/sdrs/${selectedSdr}/pauses/${postCall.id}/finish`, { method: 'POST', body: JSON.stringify(input) }); setPostCall(null); setAvailable(true); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setFinishingPause(false); } };
  const hangup = () => { if (activeCall) control.current?.send(JSON.stringify({ type: 'outcome', callId: activeCall.callId, outcome: 'sdr_hangup' })); };
  const createNumber = async (event: React.FormEvent) => { event.preventDefault(); try { await json('/api/numbers', { method: 'POST', body: JSON.stringify(numberForm) }); setNumberForm({ label: '', phone: '' }); await load(); } catch (e) { setError(String(e)); } };
  const createLead = async (event: React.FormEvent) => { event.preventDefault(); try { await json('/api/leads', { method: 'POST', body: JSON.stringify(leadForm) }); setLeadForm({ name: '', phone: '' }); await load(); } catch (e) { setError(String(e)); } };
  const importCsv = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const data = new FormData(); data.append('file', file); setImportResult(''); try { const response = await fetch(`${apiBaseUrl}/api/leads/import`, { method: 'POST', body: data }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.message ?? 'Não foi possível importar o CSV'); setImportResult(`${result.imported} contatos importados${result.skipped ? ` · ${result.skipped} linhas ignoradas` : ''}`); event.target.value = ''; await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const toggleDialer = async () => { try { await json(status.running ? '/api/dialer/pause' : '/api/dialer/start', { method: 'POST' }); await load(); } catch (e) { setError(String(e)); } };
  const showQr = async (id: string) => { if (qrBusy.current) return; qrBusy.current = true; setQrLoading(true); setQr({ qr_codes: [], status: 'loading', timeout_seconds: 60 }); setQrNumberId(id); try { setQr(await json(`/api/numbers/${id}/qr`)); setQrNumberId(id); } catch (e) { setError(String(e)); } finally { qrBusy.current = false; setQrLoading(false); } };
  const closeQr = () => { setQr(null); setQrNumberId(''); };
  const reconnectNumber = async (id: string) => { if (qrBusy.current) return; qrBusy.current = true; setQrLoading(true); setQr({ qr_codes: [], status: 'loading', timeout_seconds: 60 }); setQrNumberId(id); try { await json(`/api/numbers/${id}/reconnect`, { method: 'POST' }); await new Promise((resolve) => setTimeout(resolve, 5500)); setQr(await json(`/api/numbers/${id}/qr`)); setQrNumberId(id); } catch (e) { setError(String(e)); } finally { qrBusy.current = false; setQrLoading(false); } };
  const removeNumber = async (id: string, label: string) => { if (!window.confirm(`Remover o número ${label}? A sessão será desconectada e o registro local será arquivado.`)) return; try { await json(`/api/numbers/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const manualCall = async (id: string, name: string) => { if (!connected || !sdrReady) { setError('Conecte-se como SDR antes de iniciar uma ligação.'); return; } if (!available) { setError('Ative "Ficar disponível" antes de iniciar uma ligação.'); return; } if (!window.confirm(`Ligar agora para ${name}?`)) return; try { await json('/api/calls/manual', { method: 'POST', body: JSON.stringify({ leadId: id }) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const resetLead = async (id: string) => { if (!window.confirm('Resetar este contato? Nome e telefone serão mantidos, mas status e tentativas voltarão ao início.')) return; try { await json(`/api/leads/${id}/reset`, { method: 'POST' }); await load(); } catch (e) { setError(String(e)); } };
  const removeLead = async (id: string, name: string, phone: string) => { if (!window.confirm(`Remover o lead ${name || phone}? O contato e seu histórico de chamadas serão excluídos.`)) return; try { await json(`/api/leads/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const clearLeads = async () => { if (!window.confirm('Limpar todos os contatos e o histórico de chamadas? Esta ação não pode ser desfeita.')) return; try { await json('/api/leads', { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const navItems: { key: TabKey; label: string; icon: string; group: 'Operação' | 'Configuração' | 'Administração' }[] = [{ key: 'dashboard', label: 'Visão geral', icon: 'dashboard', group: 'Operação' }, { key: 'leads', label: 'Leads', icon: 'users', group: 'Operação' }, { key: 'calls', label: 'Histórico', icon: 'history', group: 'Operação' }, { key: 'numbers', label: 'Números', icon: 'phone', group: 'Configuração' }, { key: 'sdrs', label: 'SDRs', icon: 'headset', group: 'Configuração' }, { key: 'access', label: 'Acesso', icon: 'users', group: 'Configuração' }];
  if (isSuperAdmin) navItems.push({ key: 'admin', label: 'Admin', icon: 'settings', group: 'Administração' });
  const connectedNumbers = (status.numbers ?? []).filter((number: AnyRow) => ['connected', 'online', 'ready', 'authenticated'].includes(String(number.status).toLowerCase())).length;
  const navigationGroups = (['Operação', 'Configuração', 'Administração'] as const).map((group) => ({ label: group, items: navItems.filter((item) => item.group === group && (!isSdr || item.key === 'dashboard')) })).filter((group) => group.items.length > 0);
  const moduleTitle = navItems.find((item) => item.key === tab)?.label ?? 'Visão geral';
  const queuedLeads = status.lead_counts?.queued ?? 0;
  const availableSdrs = isSdr ? (status.sdr?.available ? 1 : 0) : (status.available_sdrs ?? 0);

  return <><div className="tenant-context-bar"><button type="button" onClick={() => void logout()}>Sair</button></div><div className="app-shell">
    <div className="app-layout"><aside className="main-sidebar"><div className="brand"><div className="brand-mark"><Icon name="phone" size={17} /></div><div><strong>Zap<span>Liga</span></strong><small>Operação SDR</small></div></div><div className="workspace-switcher"><span className="workspace-avatar">Z</span><div><strong>Minha operação</strong><small>Workspace local</small></div><Icon name="chevron" size={14} /></div><nav className="sidebar-nav" aria-label="Navegação principal">{navigationGroups.map((group) => <div className="sidebar-group" key={group.label}><span className="sidebar-label">{group.label}</span>{group.items.map((item) => <button key={item.key} className={`sidebar-item ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}><Icon name={item.icon} /><span>{item.label}</span>{item.key === 'calls' && calls.length > 0 && <em>{calls.length}</em>}</button>)}</div>)}</nav></aside>
      <aside className="context-sidebar" aria-label="Status da operação"><div className="context-title"><div className="context-icon"><Icon name="chart" size={16} /></div><div><strong>Status da operação</strong><small>Indicadores em tempo real</small></div></div><div className="context-status"><div><span className="status-line"><i className={status.running ? 'on' : ''}></i>Discador</span><small className="context-status-detail">{status.running ? 'Processando a fila' : 'Operação pausada'}</small></div><Badge tone={status.running ? 'success' : 'neutral'}>{status.running ? 'Operando' : 'Pausado'}</Badge></div><div className="context-metrics"><div className="context-metric"><span>Contatos na fila</span><strong>{queuedLeads}</strong><small>aguardando discagem</small></div><div className="context-metric"><span>Números conectados</span><strong>{connectedNumbers}</strong><small>prontos para uso</small></div><div className="context-metric"><span>SDRs disponíveis</span><strong>{availableSdrs}</strong><small>equipe online</small></div></div><div className="context-note"><Icon name="headset" size={15} /><div><strong>Central de operação</strong><small>Use o menu ao lado para acessar cada área.</small></div></div></aside>
      <main className="main-content"><div className="module-header"><div className="breadcrumb"><Icon name="chart" size={17} /><strong>{moduleTitle}</strong><span>/</span><span>Central de operação</span></div><div className="header-actions"><button className="date-filter"><Icon name="calendar" size={15} />29 jul 2026 – 27 ago 2026<Icon name="chevron" size={14} /></button>{!isSdr && <Button variant={status.running ? 'danger' : 'primary'} icon={status.running ? 'pause' : 'play'} onClick={() => void toggleDialer()}>{status.running ? 'Pausar discador' : 'Iniciar discador'}</Button>}</div></div>
        {activeCall?.lead && <div className="answered-call-banner" role="status"><div className="answered-call-contact"><span className="answered-call-icon"><Icon name="phone" size={18} /></span><div><span>CLIENTE ATENDEU</span><strong>{activeCall.lead.name}</strong><small>{activeCall.lead.phone} · <LiveTimer startedAt={activeCall.connectedAt ?? activeCall.connected_at ?? activeCall.callStartedAt} /></small></div></div><Button variant="danger" icon="close" onClick={hangup}>Encerrar chamada</Button></div>}
        {postCall && <PostCallPanel pause={postCall} onFinish={finishPostCall} submitting={finishingPause} />}
        {error && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Fechar erro"><Icon name="close" size={16} /></button></div>}
        <div className="page-content">{tab === 'dashboard' && <Dashboard status={status} available={available} connected={connected} sdrReady={sdrReady} sdrs={sdrs} selectedSdr={selectedSdr} setSelectedSdr={setSelectedSdr} setAvailability={setAvailability} logs={logs} activeCall={activeCall} hangup={hangup} connectedNumbers={connectedNumbers} postCall={postCall} />}{tab === 'numbers' && <NumbersPage numbers={numbers} numberForm={numberForm} setNumberForm={setNumberForm} createNumber={createNumber} showQr={showQr} reconnectNumber={reconnectNumber} removeNumber={removeNumber} qrLoading={qrLoading} qr={qr} closeQr={closeQr} canManageNumbers={isSuperAdmin} />}{tab === 'leads' && <LeadsPage leads={leads} leadForm={leadForm} setLeadForm={setLeadForm} createLead={createLead} importCsv={importCsv} importResult={importResult} clearLeads={clearLeads} manualCall={manualCall} resetLead={resetLead} removeLead={removeLead} />}{tab === 'sdrs' && <SdrsPage tenantId={activeTenantId} sdrs={sdrs} />}{tab === 'calls' && <CallsPage calls={calls} />}{tab === 'access' && activeTenantId && <AccessPage tenantId={activeTenantId} role={isSuperAdmin ? 'super_admin' : activeTenant?.role ?? ''} />}{tab === 'admin' && isSuperAdmin && <AdminPage onChanged={reload} />}</div>
      </main></div>
  </div></>;
}

export default function App() {
  const { session, loading, login, register, acceptInvite } = useAuth();
  if (loading) return <div className="auth-shell"><p>Carregando sessão...</p></div>;
  if (!session) {
    const match = window.location.pathname.match(/^\/(?:app\/)?invite\/([^/]+)/);
    const isRegister = /^\/(?:app\/)?cadastro\/?$/.test(window.location.pathname);
    return match ? <AcceptInvitePage token={decodeURIComponent(match[1])} acceptInvite={acceptInvite} /> : isRegister ? <RegisterPage register={register} /> : <LoginPage login={login} />;
  }
  return <AuthenticatedApp />;
}
