import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { callResultOptions, pipelineStageByCallResult } from '@web/shared/format';
import type { PanelCommand, StationSnapshot } from '../shared/types';
import { useStation } from './useStation';

const WEB_URL = __ZAPLIGA_WEB_URL__;

const formatPhone = (raw: string) => {
  let d = raw.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
};
const elapsed = (since?: number) => {
  if (!since) return '';
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const openSite = (path = '') => void chrome.runtime.sendMessage({ type: 'open-url', url: `${WEB_URL}${path}` });

export function Panel() {
  const { state, lost, send } = useStation();
  if (!state) return <div className="center muted">{lost ? 'Reconectando à extensão…' : 'Carregando…'}</div>;
  return <div className="panel">
    {state.auth === 'loading' && <div className="center muted">Verificando sua conta…</div>}
    {state.auth === 'signed_out' && <Login state={state} send={send} />}
    {state.auth === 'blocked' && <Blocked state={state} send={send} />}
    {state.auth === 'signed_in' && <Phone state={state} send={send} />}
  </div>;
}

type ViewProps = { state: StationSnapshot; send: (command: PanelCommand) => void };

function Alert({ state, send }: ViewProps) {
  if (!state.error) return null;
  return <div className="alert" role="alert"><span>{state.error}</span><button type="button" aria-label="Fechar" onClick={() => send({ cmd: 'clearError' })}>×</button></div>;
}

function Login({ state, send }: ViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); send({ cmd: 'login', email, password }); setPassword(''); };
  return <form className="login" onSubmit={submit}>
    <div className="brand">Zap<span>Liga</span></div>
    <p className="muted">Entre com a mesma conta do site. Se você já está logado no site, isto aparece sozinho.</p>
    <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
    <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
    <Alert state={state} send={send} />
    <button className="primary" disabled={state.busy}>{state.busy ? 'Entrando…' : 'Entrar'}</button>
    <button type="button" className="link" onClick={() => openSite('/esqueci-senha')}>Esqueci minha senha</button>
  </form>;
}

function Blocked({ state, send }: ViewProps) {
  return <div className="login">
    <div className="brand">Zap<span>Liga</span></div>
    <p>{state.blockedReason}</p>
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
      <div className="who"><strong>{state.user?.name}</strong>
        {state.tenants.length > 1
          ? <select aria-label="Empresa" value={state.tenantId} disabled={locked} onChange={(e) => send({ cmd: 'selectTenant', tenantId: e.target.value })}>{state.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          : <small>{tenant?.name}</small>}
      </div>
      <button className={`icon ${showSettings ? 'on' : ''}`} title="Microfone e fone" aria-label="Microfone e fone" onClick={() => setShowSettings(!showSettings)}>⚙</button>
      <button className="icon" title="Sair" aria-label="Sair" disabled={Boolean(state.call)} onClick={() => send({ cmd: 'logout' })}>⏻</button>
    </header>
    {state.micPermission !== 'granted' && state.micPermission !== 'unknown' && <div className="banner">
      <span>{state.micPermission === 'denied' ? 'O microfone está bloqueado para a extensão.' : 'Falta permitir o microfone para você falar nas ligações.'}</span>
      <button className="small" onClick={() => void chrome.runtime.sendMessage({ type: 'open-permission' })}>Permitir</button>
    </div>}
    {showSettings && <Devices state={state} send={send} />}
    <Alert state={state} send={send} />
    {state.postCall ? <PostCall state={state} send={send} /> : state.call ? <ActiveCall state={state} send={send} /> : <Dialer state={state} send={send} />}
    <footer className="status">
      <i className={state.station} />
      <span>{state.notice || (state.station === 'ready' ? 'Estação conectada' : state.station === 'connecting' ? 'Conectando…' : state.station === 'taken' ? 'Estação aberta em outro lugar' : 'Pronto para ligar')}</span>
      {state.station === 'taken' && <button className="small" onClick={() => send({ cmd: 'takeOver' })}>Usar aqui</button>}
    </footer>
  </>;
}

function Dialer({ state, send }: ViewProps) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const digits = phone.replace(/\D/g, '');
  const submit = (event: FormEvent) => { event.preventDefault(); if (digits.length >= 10) send({ cmd: 'dial', phone, name }); };
  const press = (key: string) => setPhone((current) => current + key);
  return <form className="dialer" onSubmit={submit}>
    <input className="number" inputMode="tel" placeholder="DDD + número" aria-label="Número" value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setPhone((p) => formatPhone(p))} autoFocus />
    <input className="name" placeholder="Nome (opcional)" aria-label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
    <div className="keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((key, index) => key
      ? <button type="button" key={key} onClick={() => (key === '⌫' ? setPhone((p) => p.replace(/\D/g, '').slice(0, -1)) : press(key))}>{key}</button>
      : <span key={`blank-${index}`} />)}</div>
    <button className="call" disabled={state.busy || digits.length < 10}>{state.busy ? 'Ligando…' : 'Ligar'}</button>
  </form>;
}

function ActiveCall({ state, send }: ViewProps) {
  const call = state.call!;
  const [, tick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(timer); }, []);
  const status = call.phase === 'answered' ? elapsed(call.answeredAt) : call.phase === 'ringing' ? 'Tocando…' : 'Chamando…';
  return <div className="active">
    <div className={`avatar ${call.phase}`}>{(call.name ?? '#').slice(0, 1).toUpperCase()}</div>
    <strong className="callee">{call.name || formatPhone(call.phone)}</strong>
    {call.name && <span className="muted">{formatPhone(call.phone)}</span>}
    <span className={`phase ${call.phase}`}>{status}</span>
    {call.phase === 'answered' && <span className={`hearing ${call.hearing ? 'on' : ''}`}>{call.hearing ? '● Ouvindo o cliente' : '○ Sem áudio do cliente'}</span>}
    <div className="actions">
      <button className={`round ${state.muted ? 'on' : ''}`} onClick={() => send({ cmd: 'toggleMute' })} aria-pressed={state.muted}><span className="glyph">{state.muted ? '🔇' : '🎤'}</span><small>{state.muted ? 'Mudo ativo' : 'Mudo'}</small></button>
      <button className="round hang" onClick={() => send({ cmd: 'hangup' })}><svg className="glyph" width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9Z"/></svg><small>Desligar</small></button>
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
  return <form className="postcall" onSubmit={submit}>
    <strong>Como terminou?</strong>
    <span className="muted">{[pause.leadName, pause.leadPhone && formatPhone(pause.leadPhone)].filter(Boolean).join(' · ')}</span>
    <div className="chips">{callResultOptions.map(([value, label]) => <button type="button" key={value} className={callResult === value ? 'on' : ''} aria-pressed={callResult === value} onClick={() => setCallResult(value)}>{label}</button>)}</div>
    {callResult === 'nao_ligar_novamente' && <p className="warn">Este telefone vai para a lista de não contato.</p>}
    {callbackRequired && <label>Retornar em<input type="datetime-local" min={minCallback} value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} required /></label>}
    <label>Anotação {notesRequired ? <small>obrigatória</small> : <small>opcional</small>}<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Resumo e próximo passo…" /></label>
    <button className="primary" disabled={!canSubmit || state.savingPostCall}>{state.savingPostCall ? 'Salvando…' : 'Salvar'}</button>
  </form>;
}

function Devices({ state, send }: ViewProps) {
  const { devices } = state;
  return <div className="devices">
    <label>Microfone<select value={devices.selectedInputId} onChange={(e) => send({ cmd: 'setInput', deviceId: e.target.value })}>
      <option value="">Padrão do sistema</option>
      {devices.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
    </select></label>
    {devices.outputSelectionSupported && <label>Fone / alto-falante<select value={devices.selectedOutputId} onChange={(e) => send({ cmd: 'setOutput', deviceId: e.target.value })}>
      <option value="">Automático</option>
      {devices.outputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
    </select></label>}
    <button type="button" className="small" onClick={() => send({ cmd: 'testSpeaker' })}>Testar som</button>
  </div>;
}
