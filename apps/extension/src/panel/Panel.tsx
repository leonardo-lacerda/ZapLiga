import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { callResultOptions, pipelineStageByCallResult } from '@web/shared/format';
import type { PanelCommand, StationSnapshot } from '../shared/types';
import { Icon } from './icons';
import { useStation } from './useStation';

const WEB_URL = __ZAPLIGA_WEB_URL__;

const formatPhone = (raw: string) => {
  let d = raw.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
};
/** Formats while typing: (11) 98888-7777. */
const typingPhone = (raw: string) => {
  const d = raw.replace(/\D/g, '').slice(0, 13);
  if (d.length > 11) return `+${d}`;
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};
const elapsed = (since?: number) => {
  if (!since) return '00:00';
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (ms: number) => { const total = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
const lineName = (line: { label: string; phone: string }) => [line.label, formatPhone(line.phone)].filter(Boolean).join(' · ');
/** Lines still inside a WhatsApp protection pause, re-evaluated every second while any is counting down. */
function usePausedLines(lines: StationSnapshot['lines']) {
  const [now, setNow] = useState(Date.now());
  const counting = lines.some((line) => (line.waitUntil ?? 0) > now);
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);
  return { now, paused: lines.filter((line) => (line.waitUntil ?? 0) > now) };
}
const PAUSE_ERROR = /temporariamente protegida|limite tempor[aá]rio|quarentena/i;
const initials = (name?: string) => (name ?? '').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '';
const openSite = (path = '') => void chrome.runtime.sendMessage({ type: 'open-url', url: `${WEB_URL}${path}` });

export function Panel() {
  const { state, lost, send } = useStation();
  if (!state || state.auth === 'loading') return <div className="panel"><div className="splash"><Logo /><span className="spinner" /><p className="muted">{lost ? 'Reconectando à extensão…' : 'Verificando sua conta…'}</p></div></div>;
  return <div className="panel">
    {state.auth === 'signed_out' && <Login state={state} send={send} />}
    {state.auth === 'blocked' && <Blocked state={state} send={send} />}
    {state.auth === 'signed_in' && <Phone state={state} send={send} />}
  </div>;
}

type ViewProps = { state: StationSnapshot; send: (command: PanelCommand) => void };

function Logo() {
  return <div className="logo"><span className="mark"><Icon name="phone" size={18} /></span><span className="word">Zap<b>Liga</b></span></div>;
}

function Alert({ state, send }: ViewProps) {
  if (!state.error) return null;
  // A line pause has its own alert with a timer under the line picker: no need to repeat it here.
  if (PAUSE_ERROR.test(state.error) && state.lines.some((line) => (line.waitUntil ?? 0) > Date.now())) return null;
  return <div className="alert" role="alert"><Icon name="alert" size={16} /><span>{state.error}</span><button type="button" aria-label="Fechar" onClick={() => send({ cmd: 'clearError' })}><Icon name="close" size={14} /></button></div>;
}

function Login({ state, send }: ViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); send({ cmd: 'login', email, password }); setPassword(''); };
  return <form className="login" onSubmit={submit}>
    <div className="login-head"><Logo /><h1>Entre para ligar</h1><p className="muted">Use a mesma conta do site. Se você já está logado lá, entra sozinho.</p></div>
    <label>E-mail<input type="email" autoComplete="username" placeholder="voce@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
    <label>Senha<input type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
    <Alert state={state} send={send} />
    <button className="primary" disabled={state.busy}>{state.busy ? 'Entrando…' : 'Entrar'}</button>
    <button type="button" className="link" onClick={() => openSite('/esqueci-senha')}>Esqueci minha senha</button>
  </form>;
}

function Blocked({ state, send }: ViewProps) {
  return <div className="login">
    <div className="login-head"><Logo /><h1>Quase lá</h1><p>{state.blockedReason}</p></div>
    <button className="primary" onClick={() => openSite()}>Abrir o site</button>
    <button className="link" onClick={() => send({ cmd: 'logout' })}>Sair</button>
  </div>;
}

function Phone({ state, send }: ViewProps) {
  const [showSettings, setShowSettings] = useState(false);
  const tenant = state.tenants.find((t) => t.id === state.tenantId);
  const locked = Boolean(state.call || state.postCall);
  return <>
    <header className="top">
      <span className="avatar-sm">{initials(state.user?.name) || <Icon name="user" size={16} />}</span>
      <div className="who"><strong>{state.user?.name}</strong>
        {state.tenants.length > 1
          ? <label className="tenant"><Icon name="building" size={12} /><select aria-label="Empresa" value={state.tenantId} disabled={locked} onChange={(e) => send({ cmd: 'selectTenant', tenantId: e.target.value })}>{state.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          : <small><Icon name="building" size={12} />{tenant?.name}</small>}
      </div>
      <button className={`icon ${showSettings ? 'on' : ''}`} title="Microfone e fone" aria-label="Microfone e fone" onClick={() => setShowSettings(!showSettings)}><Icon name="settings" /></button>
      <button className="icon" title="Sair" aria-label="Sair" disabled={Boolean(state.call)} onClick={() => send({ cmd: 'logout' })}><Icon name="logout" /></button>
    </header>
    {state.micPermission !== 'granted' && state.micPermission !== 'unknown' && <div className="banner">
      <Icon name="mic" size={16} />
      <span>{state.micPermission === 'denied' ? 'O microfone está bloqueado para a extensão.' : 'Permita o microfone para falar nas ligações.'}</span>
      <button className="small" onClick={() => void chrome.runtime.sendMessage({ type: 'open-permission' })}>Permitir</button>
    </div>}
    {showSettings && <Devices state={state} send={send} />}
    <Alert state={state} send={send} />
    <div className="screen">{state.postCall ? <PostCall state={state} send={send} /> : state.call ? <ActiveCall state={state} send={send} /> : <Dialer state={state} send={send} />}</div>
    <footer className="status">
      <span className={`pill ${state.call ? 'live' : state.station}`}><i />{state.notice || (state.call ? 'Em ligação' : state.station === 'ready' ? 'Estação conectada' : state.station === 'connecting' ? 'Conectando…' : state.station === 'taken' ? 'Estação aberta em outro lugar' : 'Pronto para ligar')}</span>
      {state.station === 'taken' && <button className="small" onClick={() => send({ cmd: 'takeOver' })}>Usar aqui</button>}
    </footer>
  </>;
}

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['', ''], ['0', '+'], ['back', '']];

function Dialer({ state, send }: ViewProps) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const digits = phone.replace(/\D/g, '');
  // A "Ligar com ZapLiga" button on a page (Kommo) sent a number: fill it in, ready to call.
  useEffect(() => {
    if (!state.prefill) return;
    setPhone(typingPhone(state.prefill.phone));
    setName(state.prefill.name ?? '');
    send({ cmd: 'clearPrefill' });
  }, [state.prefill?.at]);
  // Lines change on the site (a number connected or removed): ask again when the window comes into view.
  useEffect(() => {
    const refresh = () => send({ cmd: 'refreshLines' });
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const { now, paused } = usePausedLines(state.lines);
  const chosenPause = paused.find((line) => line.id === state.lineId);
  const allPaused = !state.lineId && state.lines.length > 0 && paused.length === state.lines.length;
  const blockedFor = chosenPause ? chosenPause.waitUntil! - now : allPaused ? Math.min(...paused.map((line) => line.waitUntil!)) - now : 0;
  const submit = (event: FormEvent) => { event.preventDefault(); if (digits.length >= 10 && !blockedFor) send({ cmd: 'dial', phone, name }); };
  return <form className="dialer" onSubmit={submit}>
    <div className="display">
      <input className="number" inputMode="tel" placeholder="(00) 00000-0000" aria-label="Telefone para ligar" value={phone} onChange={(e) => setPhone(typingPhone(e.target.value))} autoFocus />
      <input className="name" placeholder="Nome do contato (opcional)" aria-label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
    </div>
    <div className="keypad">{KEYS.map(([key, letters], index) => key === 'back'
      ? <button type="button" key={key} className="key ghost" aria-label="Apagar" disabled={!digits} onClick={() => setPhone((p) => typingPhone(p.replace(/\D/g, '').slice(0, -1)))}><Icon name="backspace" size={20} /></button>
      : key
        ? <button type="button" key={key} className="key" onClick={() => setPhone((p) => typingPhone(p.replace(/\D/g, '') + key))}><span>{key}</span><small>{letters}</small></button>
        : <span key={`blank-${index}`} />)}</div>
    {state.lines.length > 0 && <label className="line-pick"><span><Icon name="whatsapp" size={14} />Ligar pelo número</span>
      <select aria-label="Número de saída" value={state.lineId} onMouseDown={() => send({ cmd: 'refreshLines' })} onFocus={() => send({ cmd: 'refreshLines' })} onChange={(e) => send({ cmd: 'selectLine', lineId: e.target.value })}>
        <option value="">Automático (o que está livre há mais tempo)</option>
        {state.lines.map((line) => <option key={line.id} value={line.id}>{lineName(line)}{(line.waitUntil ?? 0) > now ? ` — pausa ${clock(line.waitUntil! - now)}` : ''}</option>)}
      </select></label>}
    {paused.map((line) => <div key={line.id} className={`line-pause${line.id === state.lineId ? ' chosen' : ''}`} role="status">
      <Icon name="alert" size={15} />
      <span><strong>{lineName(line)}</strong>{line.quarantine ? ' está em quarentena por sinais de bloqueio do WhatsApp.' : ' está em pausa de proteção do WhatsApp.'} Libera em</span>
      <b className="pause-clock">{clock(line.waitUntil! - now)}</b>
    </div>)}
    <button className="call" disabled={state.busy || digits.length < 10 || Boolean(blockedFor)} aria-label="Ligar"><Icon name="phone" size={20} /><span>{state.busy ? 'Ligando…' : blockedFor ? `Aguarde ${clock(blockedFor)}` : 'Ligar'}</span></button>
  </form>;
}

function ActiveCall({ state, send }: ViewProps) {
  const call = state.call!;
  const [, tick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(timer); }, []);
  const answered = call.phase === 'answered';
  return <div className={`active ${call.phase}`}>
    <div className="who-call">
      <div className="ring"><div className="avatar-lg">{initials(call.name) || <Icon name="user" size={30} />}</div></div>
      <strong className="callee">{call.name || formatPhone(call.phone)}</strong>
      {call.name && <span className="sub">{formatPhone(call.phone)}</span>}
      {call.line && <span className="via"><Icon name="whatsapp" size={12} />pelo número {call.line}</span>}
      <span className="phase">{answered ? elapsed(call.answeredAt) : call.phase === 'ringing' ? 'Chamando…' : 'Ligando…'}</span>
      {answered && <span className={`hearing ${call.hearing ? 'on' : ''}`}><span className="bars"><i /><i /><i /><i /></span>{call.hearing ? 'Ouvindo o cliente' : 'Sem áudio do cliente'}</span>}
    </div>
    <div className="actions">
      <button className={`round ${state.muted ? 'on' : ''}`} onClick={() => send({ cmd: 'toggleMute' })} aria-pressed={state.muted} aria-label="Mudo"><Icon name={state.muted ? 'micOff' : 'mic'} size={24} /><small>{state.muted ? 'Mudo ativo' : 'Mudo'}</small></button>
      <button className="round hang" onClick={() => send({ cmd: 'hangup' })} aria-label="Desligar"><Icon name="hangup" size={26} /><small>Desligar</small></button>
    </div>
  </div>;
}

function PostCall({ state, send }: ViewProps) {
  const pause = state.postCall!;
  const [callResult, setCallResult] = useState('');
  const [notes, setNotes] = useState('');
  const [callbackAt, setCallbackAt] = useState('');
  // Same rules as the site's post-call form (apps/web/src/features/calls/PostCallPanel.tsx).
  const notesRequired = Boolean(callResult && !['sem_interesse', 'numero_invalido', 'nao_ligar_novamente'].includes(callResult));
  const callbackRequired = callResult === 'retornar';
  const canSubmit = Boolean(callResult && (!notesRequired || notes.trim()) && (!callbackRequired || callbackAt));
  const minCallback = useMemo(() => { const d = new Date(Date.now() + 5 * 60_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    send({ cmd: 'finishPostCall', callResult, pipelineStage: pipelineStageByCallResult[callResult] ?? 'contatado', notes: notes.trim(), callbackAt: callbackAt ? new Date(callbackAt).toISOString() : undefined });
  };
  const duration = pause.durationSeconds ? `${Math.floor(pause.durationSeconds / 60)}min ${pause.durationSeconds % 60}s` : '';
  return <form className="postcall" onSubmit={submit}>
    <div className="post-head"><span className="badge"><Icon name="check" size={14} />Ligação encerrada</span><strong>Como terminou?</strong>
      <span className="muted">{[pause.leadName, pause.leadPhone && formatPhone(pause.leadPhone), duration].filter(Boolean).join(' · ')}</span></div>
    <div className="chips">{callResultOptions.map(([value, label]) => <button type="button" key={value} className={`${callResult === value ? 'on' : ''} ${pipelineStageByCallResult[value] === 'perdido' ? 'neg' : ''}`} aria-pressed={callResult === value} onClick={() => setCallResult(value)}>{label}</button>)}</div>
    {callResult === 'nao_ligar_novamente' && <p className="warn"><Icon name="alert" size={14} />Este telefone vai para a lista de não contato.</p>}
    {callbackRequired && <label>Retornar em<input type="datetime-local" min={minCallback} value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} required /></label>}
    <label><span className="label-row">Anotação {notesRequired ? <small className="req">obrigatória</small> : <small>opcional</small>}</span><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Resumo e próximo passo…" /></label>
    <button className="primary" disabled={!canSubmit || state.savingPostCall}>{state.savingPostCall ? 'Salvando…' : 'Salvar resultado'}</button>
  </form>;
}

function Devices({ state, send }: ViewProps) {
  const { devices } = state;
  return <div className="devices">
    <label><span><Icon name="mic" size={14} />Microfone</span><select value={devices.selectedInputId} onChange={(e) => send({ cmd: 'setInput', deviceId: e.target.value })}>
      <option value="">Padrão do sistema</option>
      {devices.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
    </select></label>
    {devices.outputSelectionSupported && <label><span><Icon name="headset" size={14} />Fone / alto-falante</span><select value={devices.selectedOutputId} onChange={(e) => send({ cmd: 'setOutput', deviceId: e.target.value })}>
      <option value="">Automático</option>
      {devices.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
    </select></label>}
    <button type="button" className="small" onClick={() => send({ cmd: 'testSpeaker' })}><Icon name="speaker" size={14} />Testar som</button>
  </div>;
}
