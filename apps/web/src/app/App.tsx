import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { AudioBridge } from '../audio/AudioBridge';
import { json, wsUrl } from '../services/api';
import type { AnyRow, TabKey } from '../types';
import { Badge, Button, Icon } from '../components/ui';
import { PAGE_SIZE } from '../shared/format';
import { DateRangePopover } from '../components/DateRangePopover';
import { Dashboard } from '../features/dashboard/Dashboard';
import { MetricsPage } from '../features/metrics/MetricsPage';
import { SdrMetricsPage } from '../features/metrics/SdrMetricsPage';
import { NumbersPage } from '../features/numbers/NumbersPage';
import { LeadsPage } from '../features/leads/LeadsPage';
import { SdrsPage } from '../features/sdrs/SdrsPage';
import { CallsPage } from '../features/calls/CallsPage';
import { AccessPage } from '../features/access/AccessPage';
import { AdminPage } from '../features/access/AdminPage';
import { AcceptInvitePage } from '../features/auth/AcceptInvitePage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { useAuth } from '../features/auth/AuthProvider';
import { authRouteFromPath, isPublicAuthPath, navigateToTab, tabFromPath, tabPaths } from './routes';

const pauseFromSdr = (sdr: AnyRow) => sdr?.current_pause_id && sdr.pause_started_at ? ({ id: sdr.current_pause_id, pause_type: sdr.pause_type ?? 'post_call', started_at: sdr.pause_started_at, call_id: sdr.pause_call_id, lead_name: sdr.pause_lead_name, lead_phone: sdr.pause_lead_phone, call_started_at: sdr.pause_call_started_at, call_duration_seconds: sdr.pause_call_duration_seconds, pause_elapsed_seconds: sdr.pause_elapsed_seconds }) : null;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

function AuthenticatedApp() {
  const { session, activeTenantId, selectTenant, reload, logout } = useAuth();
  const [status, setStatus] = useState<AnyRow>({});
  const [numbers, setNumbers] = useState<AnyRow[]>([]);
  const [numbersTotal, setNumbersTotal] = useState(0);
  const [numbersOffset, setNumbersOffset] = useState(0);
  const [leads, setLeads] = useState<AnyRow[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsOffset, setLeadsOffset] = useState(0);
  const [leadFolders, setLeadFolders] = useState<AnyRow[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const [folderMetrics, setFolderMetrics] = useState<AnyRow | null>(null);
  const [dateRange, setDateRange] = useState({ from: isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)), to: isoDate(new Date()) });
  const [sdrs, setSdrs] = useState<AnyRow[]>([]);
  const [calls, setCalls] = useState<AnyRow[]>([]);
  const [callsTotal, setCallsTotal] = useState(0);
  const [callsOffset, setCallsOffset] = useState(0);
  const [callsSearch, setCallsSearch] = useState('');
  const [callsStatus, setCallsStatus] = useState('');
  const [callsResult, setCallsResult] = useState('');
  const [logs, setLogs] = useState<AnyRow[]>([]);
  const [tab, setTab] = useState<TabKey>(() => tabFromPath(window.location.pathname));
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [importResult, setImportResult] = useState('');
  const [qr, setQr] = useState<any>(null);
  const [qrNumberId, setQrNumberId] = useState('');
  const [numberForm, setNumberForm] = useState({ label: '', phone: '' });
  const [leadForm, setLeadForm] = useState({ name: '', phone: '' });
  const [manualPhone, setManualPhone] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualCalling, setManualCalling] = useState(false);
  const [sdrId, setSdrId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sdrReady, setSdrReady] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [activeCall, setActiveCall] = useState<AnyRow | null>(null);
  const [postCall, setPostCall] = useState<AnyRow | null>(null);
  const [finishingPause, setFinishingPause] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const qrBusy = useRef(false);
  const control = useRef<WebSocket>();
  const audio = useRef(new AudioBridge());
  const audioCall = useRef('');
  const reconnectTimer = useRef<number>();
  const reconnectAttempt = useRef(0);
  const manualDisconnect = useRef(false);
  const desiredAvailable = useRef(false);
  const activeTenant = session?.tenants.find((tenant) => tenant.id === activeTenantId);
  const isSdr = activeTenant?.role === 'sdr';
  const isSuperAdmin = session?.user.platformRole === 'super_admin';

  const load = useCallback(async () => {
    try {
      const callsParams = new URLSearchParams({ from: dateRange.from, to: dateRange.to, limit: String(PAGE_SIZE), offset: String(callsOffset) });
      if (callsSearch.trim()) callsParams.set('search', callsSearch.trim());
      if (callsStatus) callsParams.set('status', callsStatus);
      if (callsResult) callsParams.set('result', callsResult);
      const [nextStatus, numbersPage, nextFolders, nextSdrs, callsPage, events] = isSdr
        ? [await json('/api/dialer/sdr-status'), { items: [], total: 0 }, [], [await json('/api/me/sdr')], { items: [], total: 0 }, []]
        : await Promise.all([json(`/api/dialer/status?from=${dateRange.from}&to=${dateRange.to}`), json(`/api/numbers?limit=${PAGE_SIZE}&offset=${numbersOffset}`), json('/api/lead-folders'), json('/api/sdrs?limit=500').then((page) => page.items), json(`/api/calls?${callsParams}`), json('/api/dialer/logs')]);
      const folderId = !isSdr ? (nextFolders.find((folder: AnyRow) => folder.id === selectedFolderId)?.id ?? nextFolders.find((folder: AnyRow) => folder.is_active)?.id ?? nextFolders[0]?.id ?? '') : '';
      const [leadsPage, nextMetrics] = !isSdr && folderId
        ? await Promise.all([json(`/api/lead-folders/${folderId}/leads?limit=${PAGE_SIZE}&offset=${leadsOffset}`), json(`/api/lead-folders/${folderId}/metrics?from=${dateRange.from}&to=${dateRange.to}`)])
        : [{ items: [], total: 0 }, null];
      if (folderId && folderId !== selectedFolderId) setSelectedFolderId(folderId);
      setStatus(nextStatus); setNumbers(numbersPage.items); setNumbersTotal(numbersPage.total); setLeads(leadsPage.items); setLeadsTotal(leadsPage.total); setSdrs(nextSdrs); setCalls(callsPage.items); setCallsTotal(callsPage.total); setLogs(events); setStatusError('');
      setLeadFolders(nextFolders); setFolderMetrics(nextMetrics);
      // A pending post-call pause belongs exclusively to the authenticated SDR.
      // Leaders and the super admin may see all SDRs, but must never inherit an
      // SDR's wrap-up state in their own panel.
      const ownSdr = isSdr ? nextSdrs[0] : null;
      const currentPause = ownSdr ? pauseFromSdr(ownSdr) : null;
      if (currentPause && !postCall) setPostCall(currentPause);
      if (!isSdr && postCall) setPostCall(null);
    } catch (e) {
      setStatusError(e instanceof TypeError ? 'API temporariamente indisponível. Tentando reconectar...' : (e instanceof Error ? e.message : String(e)));
    }
  }, [sdrId, postCall, activeTenantId, isSdr, selectedFolderId, dateRange.from, dateRange.to, leadsOffset, callsOffset, callsSearch, callsStatus, callsResult, numbersOffset]);

  useEffect(() => { if (!isSdr) { if (sdrId) setSdrId(''); return; } if (!sdrId && sdrs[0]?.id) setSdrId(sdrs[0].id); }, [isSdr, sdrId, sdrs]);
  useEffect(() => { setSdrId(''); setActiveCall(null); setPostCall(null); setQr(null); setQrNumberId(''); }, [activeTenantId]);
  useEffect(() => {
    if (isSdr && !['dashboard', 'sdrMetrics'].includes(tab)) navigateToTab('dashboard');
    if (!isSdr && tab === 'sdrMetrics') navigateToTab('dashboard');
  }, [isSdr, tab]);
  useEffect(() => {
    const onPopState = () => setTab(tabFromPath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    if (isSdr && !['dashboard', 'sdrMetrics'].includes(tab)) return;
    if (tabFromPath(window.location.pathname) !== tab) navigateToTab(tab);
  }, [isSdr, tab]);
  useEffect(() => { setLeadsOffset(0); }, [selectedFolderId]);
  useEffect(() => { setCallsOffset(0); }, [dateRange.from, dateRange.to, callsSearch, callsStatus, callsResult]);

  useEffect(() => {
    void load();
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = setInterval(refreshWhenVisible, isSdr ? 15000 : 5000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshWhenVisible); };
  }, [load]);
  useEffect(() => {
    if (!qrNumberId) return;
    let closed = false;
    const refresh = async () => { if (qrBusy.current) return; qrBusy.current = true; try { const next = await json(`/api/numbers/${qrNumberId}/qr`); if (!closed) setQr(next); } catch { /* mantém o último QR válido */ } finally { qrBusy.current = false; } };
    const timer = setInterval(() => void refresh(), 15000);
    return () => { closed = true; clearInterval(timer); };
  }, [qrNumberId]);

  const disconnect = async () => {
    manualDisconnect.current = true;
    desiredAvailable.current = false;
    reconnectAttempt.current = 0;
    if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = undefined;
    const socket = control.current;
    control.current = undefined;
    if (socket) { socket.onclose = null; socket.close(); }
    setAvailable(false); setConnected(false); setSdrReady(false); setMicMuted(false); setAudioReady(false); setConnectionNotice(''); setActiveCall(null);
    await audio.current.stop();
  };
  const startAudio = (socket: WebSocket, callId: string) => {
    if (audioCall.current === callId) return;
    audioCall.current = callId;
    void audio.current.start(socket).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Áudio do SDR: ${message}`);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'outcome', callId, outcome: `audio_error:${message.slice(0, 120)}` }));
    });
  };

  const connectSdr = async (reconnecting = false) => {
    if (!sdrId) { setConnectionNotice(''); setError('Seu perfil de SDR ainda está carregando'); return; }
    const sdr = sdrs.find((item) => item.id === sdrId);
    if (!sdr) { setConnectionNotice(''); setError('Não foi possível localizar seu perfil de SDR. Atualize a página e tente novamente.'); return; }
    if (!reconnecting) {
      setError('');
      manualDisconnect.current = false;
      setConnectionNotice('Verificando seu microfone…');
      try { await audio.current.prepare(); setAudioReady(true); }
      catch (e) { setConnecting(false); setAudioReady(false); setConnectionNotice(''); setError(e instanceof Error ? e.message : String(e)); return; }
    } else {
      setConnectionNotice(`Reconectando canal do SDR · tentativa ${reconnectAttempt.current}…`);
    }
    const previous = control.current;
    if (previous) { previous.onclose = null; previous.close(); }
    setConnecting(true);
    const ticketResult = await json('/api/auth/ws-ticket', { method: 'POST' }).catch((e) => { setError(e instanceof Error ? e.message : String(e)); return null; });
    if (!ticketResult?.ticket) {
      setConnecting(false); setConnectionNotice('Não foi possível autenticar o canal do SDR. Tentando novamente…');
      if (!manualDisconnect.current) {
        reconnectAttempt.current += 1;
        const delay = Math.min(15_000, 1000 * 2 ** Math.min(4, reconnectAttempt.current - 1));
        reconnectTimer.current = window.setTimeout(() => void connectSdr(true), delay);
      }
      return;
    }
    const socket = new WebSocket(`${wsUrl()}/ws/tenants/${encodeURIComponent(activeTenantId)}/sdr?ticket=${encodeURIComponent(ticketResult.ticket)}`);
    control.current = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { if (control.current !== socket) return; setConnecting(false); setConnected(true); socket.send(JSON.stringify({ type: 'identify' })); };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') { audio.current.play(event.data); return; }
      const message = JSON.parse(event.data);
      if (message.type === 'identified') {
        reconnectAttempt.current = 0; setConnecting(false); setConnected(true); setSdrReady(true); setConnectionNotice('');
        const pause = pauseFromSdr(message.sdr); if (pause) { setPostCall(pause); desiredAvailable.current = false; setAvailable(false); }
        else if (reconnecting && desiredAvailable.current) socket.send(JSON.stringify({ type: 'availability', available: true }));
        else { const nextAvailable = Boolean(message.sdr?.available); desiredAvailable.current = nextAvailable; setAvailable(nextAvailable); }
      }
      if (message.type === 'availability_changed') { desiredAvailable.current = Boolean(message.available); setAvailable(Boolean(message.available)); }
      if (message.type === 'sdr_state_changed' && message.sdrId === sdrId) { desiredAvailable.current = Boolean(message.available); setAvailable(Boolean(message.available)); }
      if (message.type === 'dialer_log') setLogs((current) => [message.log, ...current].slice(0, 100));
      if (message.type === 'call_reserved') { desiredAvailable.current = false; setAvailable(false); if (message.lead?.id) setActiveCall({ callId: message.callId, lead: message.lead, number: message.number, phase: 'ringing' }); }
      if (message.type === 'call_started' && message.lead?.name) { setAvailable(false); setActiveCall((current) => ({ ...(current ?? {}), ...message, phase: 'answered' })); startAudio(socket, message.callId); }
      if (message.type === 'media_open') { setActiveCall((current) => current ? { ...current, mediaOpen: true } : current); startAudio(socket, message.callId); }
      if (message.type === 'media_active') setActiveCall((current) => current ? { ...current, mediaActive: true, phase: 'answered' } : current);
      if (message.type === 'call_finished') {
        if (audioCall.current === message.callId) audioCall.current = ''; setActiveCall(null); setMicMuted(false); setAudioReady(false); void audio.current.stop();
        if (message.pause) { desiredAvailable.current = false; setPostCall(message.pause); setAvailable(false); }
        else {
          const restored = Boolean(message.available); desiredAvailable.current = restored; setAvailable(restored);
          if (restored) void audio.current.prepare().then(() => setAudioReady(true)).catch((e) => { desiredAvailable.current = false; setAvailable(false); setError(e instanceof Error ? e.message : String(e)); });
        }
        if (message.outcome === 'waxum_rate_limited') setError('A linha WhatsApp atingiu um limite temporário de chamadas. Aguarde alguns minutos antes de tentar novamente.'); void load();
      }
      if (message.type === 'pause_finished') { const restored = Boolean(message.available); desiredAvailable.current = restored; setPostCall(null); setAvailable(restored); void load(); }
      if (message.type === 'error') setError(message.message);
    };
    socket.onerror = () => { if (control.current === socket) { setConnecting(false); setConnectionNotice('O canal ficou instável. Tentando recuperar…'); } };
    socket.onclose = () => {
      if (control.current !== socket) return;
      control.current = undefined; setConnecting(false); audioCall.current = ''; setAvailable(false); setConnected(false); setSdrReady(false); setMicMuted(false); setActiveCall(null);
      if (manualDisconnect.current) return;
      reconnectAttempt.current += 1;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(4, reconnectAttempt.current - 1));
      setConnectionNotice(`Conexão interrompida. Nova tentativa em ${Math.ceil(delay / 1000)}s…`);
      reconnectTimer.current = window.setTimeout(() => void connectSdr(true), delay);
    };
  };

  const setAvailability = async (value: boolean) => {
    if (!connected || !sdrReady || control.current?.readyState !== WebSocket.OPEN) return;
    setError('');
    if (value) { if (postCall) { setError('Finalize o pós-atendimento antes de ficar disponível.'); return; } try { await audio.current.prepare(); setAudioReady(true); } catch (e) { setAudioReady(false); setError(e instanceof Error ? e.message : String(e)); return; } }
    else { desiredAvailable.current = false; setAudioReady(false); await audio.current.stop(); }
    desiredAvailable.current = value;
    control.current?.send(JSON.stringify({ type: 'availability', available: value }));
  };
  const toggleMicMute = () => { const next = !micMuted; audio.current.setMuted(next); setMicMuted(next); };
  const finishPostCall = async (input: AnyRow) => {
    if (!sdrId || !postCall?.id) return;
    if (input.continueAvailable && (!connected || !sdrReady)) { setError('Conecte e verifique o áudio antes de salvar como disponível.'); return; }
    setFinishingPause(true); setError('');
    try {
      if (input.continueAvailable) { await audio.current.prepare(); setAudioReady(true); }
      else { await audio.current.stop(); setAudioReady(false); }
      const result = await json(`/api/sdrs/${sdrId}/pauses/${postCall.id}/finish`, { method: 'POST', body: JSON.stringify(input) });
      const restored = Boolean(result.available); desiredAvailable.current = restored; setPostCall(null); setAvailable(restored); await load();
    } catch (e) { if (input.continueAvailable) setAudioReady(false); setError(e instanceof Error ? e.message : String(e)); }
    finally { setFinishingPause(false); }
  };
  useEffect(() => () => {
    manualDisconnect.current = true;
    if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
    const socket = control.current;
    control.current = undefined;
    if (socket) { socket.onclose = null; socket.close(); }
    void audio.current.stop();
  }, [activeTenantId]);
  const handleLogout = async () => { await disconnect(); await logout(); };
  const hangup = () => { if (!activeCall) return; const answered = activeCall.phase === 'answered' || activeCall.mediaActive; control.current?.send(JSON.stringify({ type: 'outcome', callId: activeCall.callId, outcome: answered ? 'sdr_hangup' : 'sdr_cancelled' })); };
  const createNumber = async (event: React.FormEvent) => { event.preventDefault(); try { await json('/api/numbers', { method: 'POST', body: JSON.stringify(numberForm) }); setNumberForm({ label: '', phone: '' }); await load(); } catch (e) { setError(String(e)); } };
  const createFolder = async (name: string) => { try { const folder = await json('/api/lead-folders', { method: 'POST', body: JSON.stringify({ name, isActive: true }) }); setSelectedFolderId(folder.id); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const updateFolder = async (id: string, input: AnyRow) => { try { await json(`/api/lead-folders/${id}`, { method: 'PATCH', body: JSON.stringify(input) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const removeFolder = async (id: string, name: string) => { if (!window.confirm(`Excluir a pasta ${name}? Ela precisa estar vazia para ser excluída.`)) return; try { await json(`/api/lead-folders/${id}`, { method: 'DELETE' }); if (selectedFolderId === id) setSelectedFolderId(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const createLead = async (event: React.FormEvent) => { event.preventDefault(); if (!selectedFolderId) { setError('Crie ou selecione uma pasta antes de adicionar um lead.'); return; } try { await json(`/api/lead-folders/${selectedFolderId}/leads`, { method: 'POST', body: JSON.stringify(leadForm) }); setLeadForm({ name: '', phone: '' }); await load(); } catch (e) { setError(String(e)); } };
  const importCsv = async (file: File) => { if (!selectedFolderId) { setError('Selecione uma pasta antes de importar o CSV.'); return; } const data = new FormData(); data.append('file', file); setImportResult(''); try { const result = await json(`/api/lead-folders/${selectedFolderId}/import`, { method: 'POST', body: data }); setImportResult(`${result.imported ?? 0} novos · ${result.updated ?? 0} atualizados · ${result.duplicated ?? 0} duplicados · ${result.skipped ?? 0} ignorados`); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const clearFolder = async () => { const folder = leadFolders.find((item) => item.id === selectedFolderId); if (!folder) return; if (!window.confirm(`Limpar todos os leads da pasta ${folder.name}? O histórico dessa pasta também será excluído.`)) return; try { await json(`/api/lead-folders/${selectedFolderId}/leads`, { method: 'DELETE' }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const toggleDialer = async () => { try { await json(status.running ? '/api/dialer/pause' : '/api/dialer/start', { method: 'POST' }); await load(); } catch (e) { setError(String(e)); } };
  const showQr = async (id: string) => { if (qrBusy.current) return; qrBusy.current = true; setQrLoading(true); setQr({ qr_codes: [], status: 'loading', timeout_seconds: 60 }); setQrNumberId(id); try { setQr(await json(`/api/numbers/${id}/qr`)); setQrNumberId(id); } catch (e) { setError(String(e)); } finally { qrBusy.current = false; setQrLoading(false); } };
  const closeQr = () => { setQr(null); setQrNumberId(''); };
  const reconnectNumber = async (id: string) => { if (qrBusy.current) return; qrBusy.current = true; setQrLoading(true); setQr({ qr_codes: [], status: 'loading', timeout_seconds: 60 }); setQrNumberId(id); try { await json(`/api/numbers/${id}/reconnect`, { method: 'POST' }); await new Promise((resolve) => setTimeout(resolve, 5500)); setQr(await json(`/api/numbers/${id}/qr`)); setQrNumberId(id); } catch (e) { setError(String(e)); } finally { qrBusy.current = false; setQrLoading(false); } };
  const removeNumber = async (id: string, label: string) => { if (!window.confirm(`Remover o número ${label}? A sessão será desconectada e o registro local será arquivado.`)) return; try { await json(`/api/numbers/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const manualCall = async (id: string, name: string) => { if (!connected || !sdrReady) { setError('Conecte-se como SDR antes de iniciar uma ligação.'); return; } if (postCall) { setError('Finalize o pós-atendimento antes de iniciar uma ligação.'); return; } if (!window.confirm(`Ligar agora para ${name}?`)) return; try { await audio.current.prepare(); setAudioReady(true); await json('/api/calls/manual', { method: 'POST', body: JSON.stringify({ leadId: id }) }); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const manualDial = async (event: React.FormEvent) => { event.preventDefault(); if (!connected || !sdrReady) { setError('Conecte-se como SDR antes de iniciar uma ligação.'); return; } if (postCall) { setError('Finalize o pós-atendimento antes de iniciar uma ligação.'); return; } if (!manualPhone.trim()) { setError('Informe o telefone que deseja chamar.'); return; } if (!window.confirm(`Ligar agora para ${manualPhone.trim()}?`)) return; setManualCalling(true); setError(''); try { await audio.current.prepare(); setAudioReady(true); await json('/api/calls/manual', { method: 'POST', body: JSON.stringify({ phone: manualPhone.trim(), name: manualName.trim() || undefined }) }); setManualPhone(''); setManualName(''); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setManualCalling(false); } };
  const resetLead = async (id: string) => { if (!window.confirm('Resetar este contato? Nome e telefone serão mantidos, mas status e tentativas voltarão ao início.')) return; try { await json(`/api/leads/${id}/reset`, { method: 'POST' }); await load(); } catch (e) { setError(String(e)); } };
  const removeLead = async (id: string, name: string, phone: string) => { if (!window.confirm(`Remover o lead ${name || phone}? O contato e seu histórico de chamadas serão excluídos.`)) return; try { await json(`/api/leads/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const clearLeads = async () => { if (!window.confirm('Limpar todos os contatos e o histórico de chamadas? Esta ação não pode ser desfeita.')) return; try { await json('/api/leads', { method: 'DELETE' }); await load(); } catch (e) { setError(String(e)); } };
  const navItems: { key: TabKey; label: string; icon: string; group: 'Operação' | 'Configuração' | 'Administração' }[] = [
    { key: 'dashboard', label: isSdr ? 'Minha estação' : 'Visão geral', icon: 'dashboard', group: 'Operação' },
    ...(isSdr ? [{ key: 'sdrMetrics' as TabKey, label: 'Meus resultados', icon: 'chart', group: 'Operação' as const }] : []),
    { key: 'metrics', label: 'Métricas', icon: 'chart', group: 'Operação' },
    { key: 'leads', label: 'Leads', icon: 'users', group: 'Operação' },
    { key: 'calls', label: 'Histórico', icon: 'history', group: 'Operação' },
    { key: 'numbers', label: 'Números', icon: 'phone', group: 'Configuração' },
    { key: 'sdrs', label: 'SDRs', icon: 'headset', group: 'Configuração' },
    { key: 'access', label: 'Acesso', icon: 'users', group: 'Configuração' },
  ];
  if (isSuperAdmin) navItems.push({ key: 'admin', label: 'Admin', icon: 'settings', group: 'Administração' });
  const connectedNumbers = (status.numbers ?? []).filter((number: AnyRow) => ['connected', 'online', 'ready', 'authenticated'].includes(String(number.status).toLowerCase())).length;
  const navigationGroups = (['Operação', 'Configuração', 'Administração'] as const).map((group) => ({ label: group, items: navItems.filter((item) => item.group === group && (!isSdr || ['dashboard', 'sdrMetrics'].includes(item.key))) })).filter((group) => group.items.length > 0);
  const moduleTitle = navItems.find((item) => item.key === tab)?.label ?? 'Visão geral';
  const queuedLeads = isSdr ? (status.queue?.total ?? 0) : (status.lead_counts?.queued ?? 0);
  const availableSdrs = isSdr ? (status.sdr?.available ? 1 : 0) : (status.available_sdrs ?? 0);

  return <><div className="app-shell">
    <div className={`app-layout${isSdr ? ' is-sdr' : ''}`}><aside className="main-sidebar"><div className="brand"><div className="brand-mark"><Icon name="phone" size={17} /></div><div><strong>Zap<span>Liga</span></strong><small>Operação SDR</small></div></div><div className="workspace-switcher"><span className="workspace-avatar">{activeTenant?.name?.slice(0, 1).toUpperCase() ?? 'Z'}</span><div><strong>{activeTenant?.name ?? 'Minha operação'}</strong><small>{isSdr ? 'Estação de atendimento' : 'Central de gestão'}</small></div></div><nav className="sidebar-nav" aria-label="Navegação principal">{navigationGroups.map((group) => <div className="sidebar-group" key={group.label}><span className="sidebar-label">{group.label}</span>{group.items.map((item) => <button key={item.key} className={`sidebar-item ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}><Icon name={item.icon} /><span>{item.label}</span>{item.key === 'calls' && callsTotal > 0 && <em>{callsTotal}</em>}</button>)}</div>)}</nav><div className="sidebar-bottom"><div className="user-card"><span className="avatar">{session?.user.name?.slice(0, 1).toUpperCase()}</span><div><strong>{session?.user.name}</strong><small>{session?.user.email}</small></div></div><Button variant="ghost" onClick={() => void handleLogout()}>Sair da conta</Button></div></aside>
      {!isSdr && <aside className="context-sidebar" aria-label="Status da operação"><div className="context-title"><div className="context-icon"><Icon name="chart" size={16} /></div><div><strong>Status da operação</strong><small>Indicadores em tempo real</small></div></div><div className="context-status"><div><span className="status-line"><i className={status.running ? 'on' : ''}></i>Discador</span><small className="context-status-detail">{status.running ? 'Processando a fila' : 'Operação pausada'}</small></div><Badge tone={status.running ? 'success' : 'neutral'}>{status.running ? 'Operando' : 'Pausado'}</Badge></div><div className="context-metrics"><div className="context-metric"><span>Contatos na fila</span><strong>{queuedLeads}</strong><small>aguardando discagem</small></div><div className="context-metric"><span>Números conectados</span><strong>{connectedNumbers}</strong><small>prontos para uso</small></div><div className="context-metric"><span>SDRs disponíveis</span><strong>{availableSdrs}</strong><small>equipe online</small></div></div><div className="context-note"><Icon name="headset" size={15} /><div><strong>Central de operação</strong><small>Use o menu ao lado para acessar cada área.</small></div></div></aside>}
      <main className="main-content"><div className="module-header"><div className="breadcrumb"><Icon name={isSdr ? 'headset' : 'chart'} size={17} /><strong>{moduleTitle}</strong><span>/</span><span>{activeTenant?.name ?? 'Central de operação'}</span></div><div className="header-actions">{isSdr ? <><span className="sdr-header-user"><strong>{session?.user.name}</strong><small>{connected ? 'Canal conectado' : 'Canal offline'}</small></span><Button variant="ghost" onClick={() => void handleLogout()}>Sair</Button></> : <><DateRangePopover value={dateRange} onChange={setDateRange} /><Button variant={status.running ? 'danger' : 'primary'} icon={status.running ? 'pause' : 'play'} onClick={() => void toggleDialer()}>{status.running ? 'Pausar discador' : 'Iniciar discador'}</Button></>}</div></div>
        {(error || statusError) && <div className="alert app-alert" role="alert"><Icon name="alert" size={17} /><span>{error || statusError}</span>{statusError && !error && <Button variant="ghost" onClick={() => void load()}>Tentar agora</Button>}{error && <button onClick={() => setError('')} aria-label="Fechar erro"><Icon name="close" size={16} /></button>}</div>}
        {tab === 'sdrMetrics' && isSdr && <div className="page-content"><SdrMetricsPage /></div>}
        <div className="page-content">{tab === 'dashboard' && <Dashboard isSdr={isSdr} status={status} available={available} connected={connected} connecting={connecting} sdrReady={sdrReady} sdrs={sdrs} connectSdr={connectSdr} disconnectSdr={disconnect} setAvailability={setAvailability} manualDial={manualDial} manualPhone={manualPhone} setManualPhone={setManualPhone} manualName={manualName} setManualName={setManualName} manualCalling={manualCalling} logs={logs} activeCall={activeCall} hangup={hangup} micMuted={micMuted} toggleMicMute={toggleMicMute} connectedNumbers={connectedNumbers} postCall={postCall} finishPostCall={finishPostCall} finishingPause={finishingPause} audioReady={audioReady} connectionNotice={connectionNotice} dateRange={dateRange} />}{tab === 'metrics' && activeTenantId && <MetricsPage tenantId={activeTenantId} leadFolders={leadFolders} sdrs={sdrs} numbers={numbers} />}{tab === 'numbers' && <NumbersPage numbers={numbers} numbersTotal={numbersTotal} numbersOffset={numbersOffset} onNumbersPageChange={setNumbersOffset} numberForm={numberForm} setNumberForm={setNumberForm} createNumber={createNumber} showQr={showQr} reconnectNumber={reconnectNumber} removeNumber={removeNumber} qrLoading={qrLoading} qr={qr} closeQr={closeQr} canManageNumbers={!isSdr} />}{tab === 'leads' && <LeadsPage leads={leads} leadsTotal={leadsTotal} leadsOffset={leadsOffset} onLeadsPageChange={setLeadsOffset} folders={leadFolders} selectedFolderId={selectedFolderId} selectedFolder={leadFolders.find((folder) => folder.id === selectedFolderId)} metrics={folderMetrics} setSelectedFolderId={setSelectedFolderId} createFolder={createFolder} updateFolder={updateFolder} removeFolder={removeFolder} leadForm={leadForm} setLeadForm={setLeadForm} createLead={createLead} importCsv={importCsv} importResult={importResult} clearFolder={clearFolder} manualCall={manualCall} resetLead={resetLead} removeLead={removeLead} />}{tab === 'sdrs' && <SdrsPage tenantId={activeTenantId} sdrs={sdrs} />}{tab === 'calls' && <CallsPage calls={calls} callsTotal={callsTotal} callsOffset={callsOffset} onCallsPageChange={setCallsOffset} search={callsSearch} onSearchChange={setCallsSearch} status={callsStatus} onStatusChange={setCallsStatus} result={callsResult} onResultChange={setCallsResult} />}{tab === 'access' && activeTenantId && <AccessPage tenantId={activeTenantId} role={isSuperAdmin ? 'super_admin' : activeTenant?.role ?? ''} />}{tab === 'admin' && isSuperAdmin && <AdminPage onChanged={reload} onOpenTenant={(tenantId) => { selectTenant(tenantId); setTab('dashboard'); }} />}</div>
      </main></div>
  </div></>;
}

export default function App() {
  const { session, loading, login, register, acceptInvite } = useAuth();
  useEffect(() => {
    if (session && isPublicAuthPath(window.location.pathname)) window.history.replaceState({}, '', tabPaths.dashboard);
  }, [session]);
  if (loading) return <div className="auth-shell"><p>Carregando sessão...</p></div>;
  if (!session) {
    const route = authRouteFromPath(window.location.pathname);
    return route.type === 'invite' ? <AcceptInvitePage token={route.token} acceptInvite={acceptInvite} /> : route.type === 'register' ? <RegisterPage register={register} /> : <LoginPage login={login} />;
  }
  return <AuthenticatedApp />;
}
