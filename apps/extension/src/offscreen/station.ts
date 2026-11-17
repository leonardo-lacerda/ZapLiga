import { AudioBridge } from '@web/audio/AudioBridge';
import { ApiError, clearAccessToken, clearActiveTenantId, json, refreshAccessToken, refreshFailureReason, setAccessToken, setActiveTenantId, wsUrl } from '@web/services/api';
import type { BubbleStatus, PanelCommand, StationSnapshot } from '../shared/types';
import { BUBBLE_PORT, PANEL_PORT } from '../shared/types';

/**
 * The extension's calling station. It lives in the offscreen document, so one call keeps
 * running while the user changes tabs, navigates or collapses the floating window. It speaks
 * the same control protocol as the web app's station (apps/web/src/app/App.tsx: connectSdr,
 * manualDial, hangup, toggleMicMute) and reuses the web's AudioBridge and API client as-is.
 */

const TENANT_KEY = 'zapliga_ext_tenant';
const LINE_KEY = 'zapliga_ext_line:';
const CONNECTED_LINE = new Set(['connected', 'online', 'ready', 'authenticated']);
const message = (error: unknown) => {
  // Validation errors come back as a list of messages; show them instead of a bare "Bad Request".
  const list = error instanceof ApiError ? (error.details as any)?.message : undefined;
  if (Array.isArray(list) && list.length) return list.join(' · ');
  if (error instanceof ApiError && error.status === 401) return 'Sua sessão do ZapLiga caiu. Entre de novo para continuar.';
  return error instanceof Error ? error.message : String(error);
};

/**
 * The refresh cookie is shared with the zapliga.com tabs, and every rotation (here or on the
 * site) invalidates the other side's access token. `json` already refreshes once on 401; if the
 * site rotates again in between, try a couple more times before giving up. A 401 is rejected by
 * the auth guard before the handler runs, so retrying a POST is safe.
 */
const api = async (path: string, init?: RequestInit): Promise<any> => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await json(path, init); } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || attempt >= 2) throw error;
      if (!await refreshAccessToken()) throw error;
    }
  }
};

/** 10/11 digits = Brazilian DDD + number; WhatsApp needs the country code. */
export const normalizePhone = (raw: string) => {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
};

export class Station {
  private readonly audio = new AudioBridge();
  private state: StationSnapshot;
  private panels = new Set<any>();
  private bubbles = new Set<any>();
  private socket?: WebSocket;
  private sdrId = '';
  private identified?: { resolve: () => void; reject: (error: Error) => void };
  private connecting?: Promise<void>;
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private audioCallId = '';
  private pendingHangup = false;

  constructor() {
    this.state = {
      auth: 'loading', tenants: [], tenantId: '', busy: false, station: 'off', micPermission: 'unknown',
      call: null, muted: false, lines: [], lineId: '', postCall: null, savingPostCall: false, devices: this.audio.getDeviceState(), notice: '', error: '',
    };
    this.audio.onDeviceState((devices) => this.patch({ devices }));
    this.audio.onInboundLevel((level) => {
      const call = this.state.call;
      if (call && call.hearing !== level.receiving) this.patch({ call: { ...call, hearing: level.receiving } });
    });
    window.addEventListener('zapliga:access-changed', () => void this.restoreSession());
    // No timed refresh: `json` renews an expiring token right before each request, and every
    // extra rotation would also invalidate the token of the zapliga.com tabs.
  }

  // ------------------------------------------------------------------ wiring

  attach() {
    chrome.runtime.onConnect.addListener((port: any) => {
      if (port.name === PANEL_PORT) {
        this.panels.add(port);
        port.onDisconnect.addListener(() => this.panels.delete(port));
        port.onMessage.addListener((command: PanelCommand) => void this.handle(command));
        port.postMessage(this.state);
        void this.checkMicPermission();
        if (this.state.auth === 'signed_in') void this.loadLines();
      } else if (port.name === BUBBLE_PORT) {
        this.bubbles.add(port);
        port.onDisconnect.addListener(() => this.bubbles.delete(port));
        port.postMessage(this.bubble());
      }
    });
    chrome.runtime.onMessage.addListener((request: any) => {
      if (request?.type === 'microphone-permission-changed') void this.checkMicPermission();
    });
    void this.checkMicPermission();
    void this.restoreSession();
  }

  private patch(next: Partial<StationSnapshot>) {
    this.state = { ...this.state, ...next };
    for (const port of this.panels) { try { port.postMessage(this.state); } catch { this.panels.delete(port); } }
    const bubble = this.bubble();
    for (const port of this.bubbles) { try { port.postMessage(bubble); } catch { this.bubbles.delete(port); } }
  }

  private bubble(): BubbleStatus {
    const { call, postCall } = this.state;
    const label = call ? (call.phase === 'answered' ? 'Em ligação' : 'Chamando…') : postCall ? 'Registrar resultado' : '';
    return { inCall: Boolean(call), label, answeredAt: call?.answeredAt, postCall: Boolean(postCall) };
  }

  private fail(error: unknown) { this.patch({ error: message(error), busy: false }); }

  private async handle(command: PanelCommand) {
    try {
      switch (command.cmd) {
        case 'login': return await this.login(command.email, command.password);
        case 'logout': return await this.logout();
        case 'selectTenant': return await this.selectTenant(command.tenantId);
        case 'dial': return await this.dial(command.phone, command.name);
        case 'hangup': return this.hangup();
        case 'toggleMute': { const muted = !this.state.muted; this.audio.setMuted(muted); return this.patch({ muted }); }
        case 'selectLine': {
          try { localStorage.setItem(LINE_KEY + this.state.tenantId, command.lineId); } catch { /* só nesta sessão */ }
          return this.patch({ lineId: command.lineId });
        }
        case 'refreshLines': return await this.loadLines();
        case 'finishPostCall': {
          const { callResult, pipelineStage, notes, callbackAt } = command;
          return await this.finishPostCall({ callResult, pipelineStage, notes, callbackAt });
        }
        case 'takeOver': this.patch({ station: 'off', notice: '' }); return await this.ensureStation();
        case 'setInput': return await this.audio.setInputDevice(command.deviceId);
        case 'setOutput': return await this.audio.setOutputDevice(command.deviceId);
        case 'testSpeaker': return await this.audio.playTestTone();
        case 'refreshPermission': return await this.checkMicPermission();
        case 'clearError': return this.patch({ error: '' });
      }
    } catch (error) { this.fail(error); }
  }

  // ------------------------------------------------------------------ microphone

  private async checkMicPermission() {
    let micPermission: StationSnapshot['micPermission'] = 'unknown';
    try { micPermission = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state; } catch { /* older browsers: find out on first call */ }
    if (micPermission !== this.state.micPermission) this.patch({ micPermission });
    if (micPermission === 'granted') await this.audio.refreshDevices();
  }

  private async prepareAudio() {
    await this.checkMicPermission();
    // The offscreen document cannot show the browser's permission prompt; an extension tab asks once.
    if (this.state.micPermission === 'prompt' || this.state.micPermission === 'denied') throw new Error('Permita o uso do microfone pela extensão (botão acima) e tente de novo.');
    await this.audio.prepare();
  }

  // ------------------------------------------------------------------ account

  private async restoreSession() {
    // Same refresh cookie as zapliga.com: logged in on the site = logged in here.
    if (!await refreshAccessToken(true)) {
      if (refreshFailureReason() === 'transient' && this.state.auth === 'signed_in') return;
      this.signedOut();
      return;
    }
    await this.loadSession();
  }

  private async loadSession() {
    const session = await json('/api/auth/me', undefined, false);
    const user = { name: String(session.user?.name ?? ''), email: String(session.user?.email ?? '') };
    const tenants = (session.tenants ?? [])
      .filter((tenant: any) => tenant.status === 'active' && tenant.membership_status !== 'blocked')
      .map((tenant: any) => ({ id: String(tenant.id), name: String(tenant.name), role: String(tenant.role ?? '') }));
    const blockedReason = !session.user?.emailVerifiedAt ? 'Confirme seu e-mail no site do ZapLiga para continuar.'
      : session.user?.forcePasswordChange ? 'Troque sua senha no site do ZapLiga para continuar.'
      : session.legalAcceptanceRequired ? 'Aceite os termos atualizados no site do ZapLiga para continuar.'
      : !tenants.length ? 'Sua conta não está ligada a nenhuma empresa ativa.' : undefined;
    let remembered = '';
    try { remembered = localStorage.getItem(TENANT_KEY) ?? ''; } catch { /* sem preferência */ }
    const tenantId = this.state.tenantId && tenants.some((t: any) => t.id === this.state.tenantId) ? this.state.tenantId
      : tenants.find((t: any) => t.id === remembered)?.id ?? tenants[0]?.id ?? '';
    if (tenantId) setActiveTenantId(tenantId);
    this.patch({ auth: blockedReason ? 'blocked' : 'signed_in', blockedReason, user, tenants, tenantId, busy: false });
    if (!blockedReason) await Promise.all([this.loadPendingPostCall(), this.loadLines()]);
  }

  /** Connected lines for the picker. Only leaders and admins may list them; SDRs keep the automatic choice. */
  private async loadLines() {
    const tenantId = this.state.tenantId;
    const tenant = this.state.tenants.find((t) => t.id === tenantId);
    if (!tenant || tenant.role === 'sdr') { this.patch({ lines: [], lineId: '' }); return; }
    try {
      const page = await api('/api/numbers?limit=200');
      if (this.state.tenantId !== tenantId) return;
      const lines = (page.items ?? [])
        .filter((n: any) => CONNECTED_LINE.has(String(n.status).toLowerCase()))
        .map((n: any) => ({ id: String(n.id), label: String(n.label ?? ''), phone: String(n.phone ?? '') }));
      let remembered = '';
      try { remembered = localStorage.getItem(LINE_KEY + tenantId) ?? ''; } catch { /* sem preferência */ }
      const wanted = this.state.lineId || remembered;
      this.patch({ lines, lineId: lines.some((l: any) => l.id === wanted) ? wanted : '' });
    } catch { /* the picker is optional: calls still go out on the automatic line */ }
  }

  /** A call ended earlier (here or on the site) may still need its result: show the form right away. */
  private async loadPendingPostCall() {
    const tenantId = this.state.tenantId;
    try {
      const sdr = await api('/api/me/sdr');
      if (this.state.tenantId !== tenantId) return;
      this.sdrId = String(sdr.id);
      const postCall = sdr.current_pause_id && (sdr.pause_type ?? 'post_call') === 'post_call'
        ? { id: String(sdr.current_pause_id), leadName: sdr.pause_lead_name, leadPhone: sdr.pause_lead_phone, durationSeconds: Number(sdr.pause_call_duration_seconds) || 0 }
        : null;
      if (!this.state.call) this.patch({ postCall });
    } catch { /* no station yet (it is created on the first call) */ }
  }

  private signedOut() {
    this.closeSocket();
    clearAccessToken(); clearActiveTenantId();
    this.sdrId = '';
    void this.audio.stop();
    this.patch({ auth: 'signed_out', user: undefined, tenants: [], tenantId: '', station: 'off', call: null, postCall: null, muted: false, lines: [], lineId: '', busy: false });
  }

  private async login(email: string, password: string) {
    this.patch({ busy: true, error: '' });
    try {
      const result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      setAccessToken(result.accessToken);
      await this.loadSession();
    } catch (error) {
      this.patch({ busy: false, error: error instanceof ApiError && error.status === 401 ? 'E-mail ou senha incorretos.' : message(error) });
    }
  }

  private async logout() {
    if (this.state.call) throw new Error('Desligue a ligação antes de sair.');
    try { await json('/api/auth/logout', { method: 'POST' }, false); } finally { this.signedOut(); }
  }

  private async selectTenant(tenantId: string) {
    if (this.state.call || this.state.postCall) throw new Error('Termine a ligação antes de trocar de empresa.');
    this.closeSocket();
    this.sdrId = '';
    setActiveTenantId(tenantId);
    try { localStorage.setItem(TENANT_KEY, tenantId); } catch { /* só nesta sessão */ }
    this.patch({ tenantId, station: 'off', postCall: null, lines: [], lineId: '', notice: '', error: '' });
    await Promise.all([this.loadPendingPostCall(), this.loadLines()]);
  }

  // ------------------------------------------------------------------ control channel

  /** Opens the station only when it is needed: an always-on one would fight the site's station. */
  private ensureStation(): Promise<void> {
    if (this.state.station === 'ready' && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connect() {
    const tenant = this.state.tenants.find((t) => t.id === this.state.tenantId);
    if (!tenant) throw new Error('Escolha a empresa antes de ligar.');
    this.patch({ station: 'connecting' });
    try {
      if (!this.sdrId) {
        // SDRs already have a station; leaders and the platform admin get one created on first use, like on the site.
        const sdr = await api('/api/me/sdr').catch((error) => (error instanceof ApiError && error.status === 404 && tenant.role !== 'sdr' ? api('/api/me/sdr', { method: 'POST' }) : Promise.reject(error)));
        this.sdrId = String(sdr.id);
      }
      const ticket = await api('/api/auth/ws-ticket', { method: 'POST' });
      this.closeSocket();
      const socket = new WebSocket(`${wsUrl()}/ws/tenants/${encodeURIComponent(tenant.id)}/sdr?ticket=${encodeURIComponent(ticket.ticket)}`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const ready = new Promise<void>((resolve, reject) => {
        this.identified = { resolve, reject };
        window.setTimeout(() => reject(new Error('A estação não respondeu. Tente de novo.')), 10_000);
      });
      socket.onopen = () => socket.send(JSON.stringify({ type: 'identify' }));
      socket.onmessage = (event) => this.onSocketMessage(socket, event);
      socket.onclose = (event) => this.onSocketClose(socket, event);
      await ready;
      this.reconnectAttempt = 0;
    } catch (error) {
      if (this.state.station === 'connecting') this.patch({ station: 'off' });
      throw error;
    } finally {
      this.identified = undefined;
    }
  }

  private closeSocket() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) { socket.onclose = null; socket.close(); }
  }

  private onSocketClose(socket: WebSocket, event: CloseEvent) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.audioCallId = '';
    this.identified?.reject(new Error('A estação foi fechada pelo servidor.'));
    const hadCall = Boolean(this.state.call);
    if (hadCall) { this.audio.stopRingback(); void this.audio.stop(); }
    if (event.code === 4000) {
      // Another station for this user (the site or another browser) took over. Never reconnect on
      // our own: the site reconnects too, and the two would keep kicking each other out.
      this.patch({ station: 'taken', call: null, muted: false, notice: 'Sua estação foi aberta em outro lugar (site do ZapLiga ou outro navegador).' });
      return;
    }
    if (!hadCall) { this.patch({ station: 'off' }); return; }
    // A call was running: try to get back to it, like the site does.
    this.reconnectAttempt += 1;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(4, this.reconnectAttempt - 1));
    this.patch({ station: 'connecting', call: null, notice: `Conexão interrompida. Nova tentativa em ${Math.ceil(delay / 1000)}s…` });
    this.reconnectTimer = window.setTimeout(() => { void this.ensureStation().then(() => this.patch({ notice: '' })).catch((error) => this.fail(error)); }, delay);
  }

  private startAudio(socket: WebSocket, callId: string) {
    if (this.audioCallId === callId) return;
    this.audioCallId = callId;
    void this.audio.start(socket, callId).catch((error) => {
      const text = message(error);
      this.patch({ error: `Áudio: ${text}` });
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'outcome', callId, outcome: `audio_error:${text.slice(0, 120)}` }));
    });
  }

  private setCallId(callId: string) {
    const call = this.state.call;
    if (!call || call.callId === callId) return;
    this.patch({ call: { ...call, callId } });
    if (this.pendingHangup) this.hangup();
  }

  private answered() {
    const call = this.state.call;
    if (!call || call.phase === 'answered') return;
    this.audio.stopRingback();
    this.patch({ call: { ...call, phase: 'answered', answeredAt: Date.now() } });
  }

  private onSocketMessage(socket: WebSocket, event: MessageEvent) {
    if (typeof event.data !== 'string') { this.audio.play(event.data); return; }
    let data: any;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data.type) {
      case 'identified': {
        const sdr = data.sdr ?? {};
        const postCall = sdr.current_pause_id && (sdr.pause_type ?? 'post_call') === 'post_call' ? { id: String(sdr.current_pause_id), leadName: sdr.pause_lead_name, leadPhone: sdr.pause_lead_phone, durationSeconds: Number(sdr.pause_call_duration_seconds) || 0 } : null;
        // The extension only places manual calls: never stay in the automatic queue.
        if (sdr.available && !postCall) socket.send(JSON.stringify({ type: 'availability', available: false }));
        this.patch({ station: 'ready', notice: '', postCall: this.state.postCall ?? postCall });
        this.identified?.resolve();
        break;
      }
      case 'call_reserved':
        if (this.state.call) { this.patch({ call: { ...this.state.call, phase: 'ringing', name: data.lead?.name ?? this.state.call.name, line: data.number ? String(data.number.label || data.number.phone || '') : this.state.call.line } }); if (data.callId) this.setCallId(String(data.callId)); }
        break;
      case 'call_started':
        if (this.state.call && data.callId) this.setCallId(String(data.callId));
        this.answered();
        if (data.callId) this.startAudio(socket, String(data.callId));
        break;
      case 'media_open':
        if (data.callId) { this.setCallId(String(data.callId)); this.startAudio(socket, String(data.callId)); }
        break;
      case 'media_active':
        this.answered();
        break;
      case 'call_finished': {
        if (this.audioCallId === data.callId) this.audioCallId = '';
        this.pendingHangup = false;
        this.audio.stopRingback();
        void this.audio.stop();
        const pause = data.pause ? { id: String(data.pause.id), leadName: data.pause.lead_name, leadPhone: data.pause.lead_phone, durationSeconds: Number(data.pause.call_duration_seconds) || 0 } : null;
        const error = data.outcome === 'waxum_rate_limited' ? 'A linha WhatsApp atingiu um limite temporário de chamadas. Aguarde alguns minutos.' : this.state.error;
        this.patch({ call: null, muted: false, postCall: pause, error, notice: '' });
        void this.loadLines();
        if (data.available) socket.send(JSON.stringify({ type: 'availability', available: false }));
        break;
      }
      case 'pause_finished':
        this.patch({ postCall: null });
        break;
      case 'error':
        this.patch({ error: String(data.message ?? 'Erro na estação') });
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ calls

  private async dial(rawPhone: string, name?: string) {
    if (this.state.call) throw new Error('Já existe uma ligação em andamento.');
    if (this.state.postCall) throw new Error('Registre o resultado da última ligação antes de ligar de novo.');
    const phone = normalizePhone(rawPhone);
    if (phone.length < 12 || phone.length > 15) throw new Error('Digite o número com DDD (ex.: 11 98888-7777).');
    this.patch({ error: '', notice: '', busy: true });
    try {
      await this.prepareAudio();
      await this.ensureStation();
      // Connecting may reveal a result still to be registered (from a call on the site, for example).
      if (this.state.postCall) throw new Error('Registre o resultado da última ligação antes de ligar de novo.');
      this.pendingHangup = false;
      this.patch({ call: { phase: 'dialing', phone, name: name?.trim() || undefined, hearing: false }, muted: false });
      this.audio.setMuted(false);
      void this.audio.startRingback().catch(() => undefined);
      const result = await api('/api/calls/manual', { method: 'POST', body: JSON.stringify({ phone, name: name?.trim() || undefined, numberId: this.state.lineId || undefined }) });
      if (result?.callId) this.setCallId(String(result.callId));
      this.patch({ busy: false });
    } catch (error) {
      this.audio.stopRingback();
      // A server without the line choice yet rejects the field: say what to do instead of "Bad Request".
      if (this.state.lineId && /numberId should not exist/.test(message(error))) {
        error = new Error('O servidor do ZapLiga ainda não aceita escolher o número. Use "Automático" por enquanto.');
      }
      const current = this.state.call as StationSnapshot['call'];
      if (!current?.callId) { this.patch({ call: null }); void this.audio.stop(); }
      throw error;
    }
  }

  private hangup() {
    const call = this.state.call;
    if (!call) return;
    if (!call.callId || this.socket?.readyState !== WebSocket.OPEN) { this.pendingHangup = true; this.patch({ notice: 'Encerrando…' }); return; }
    this.pendingHangup = false;
    this.socket.send(JSON.stringify({ type: 'outcome', callId: call.callId, outcome: call.phase === 'answered' ? 'sdr_hangup' : 'sdr_cancelled' }));
    this.patch({ notice: 'Encerrando…' });
  }

  private async finishPostCall(input: { callResult: string; pipelineStage: string; notes: string; callbackAt?: string }) {
    const pause = this.state.postCall;
    if (!pause || !this.sdrId) return;
    this.patch({ savingPostCall: true, error: '' });
    try {
      await api(`/api/sdrs/${this.sdrId}/pauses/${pause.id}/finish`, { method: 'POST', body: JSON.stringify({ ...input, continueAvailable: false }) });
      this.patch({ postCall: null, savingPostCall: false, notice: '' });
    } catch (error) {
      this.patch({ savingPostCall: false });
      throw error;
    }
  }
}
