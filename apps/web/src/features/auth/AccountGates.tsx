import { FormEvent, useState } from 'react';
import { Button, Panel } from '../../components/ui';
import { json } from '../../services/api';
import type { AuthSession } from './AuthProvider';
import { AuthShell } from './AuthLayout';

export function EmailVerificationGate({ session, reload }: { session: AuthSession; reload: () => Promise<void> }) {
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const resend = async () => { setBusy(true); try { const result = await json('/api/auth/email/resend-verification', { method: 'POST', body: JSON.stringify({ email: session.user.email }) }); setMessage(result.message); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">CONFIRME SEU E-MAIL</span><h1>Verifique sua caixa de entrada</h1><p className="auth-intro">Enviamos um link de verificação para {session.user.email}. Depois de confirmar, volte aqui para continuar.</p>{message && <div className="alert" role="status">{message}</div>}<div className="auth-form"><Button disabled={busy} onClick={() => void resend()}>{busy ? 'Enviando…' : 'Reenviar verificação'}</Button><Button variant="ghost" onClick={() => void reload()}>Já verifiquei</Button></div></Panel></AuthShell>;
}

export function LegalAcceptanceGate({ session, reload }: { session: AuthSession; reload: () => Promise<void> }) {
  const [accepted, setAccepted] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await json('/api/me/legal-acceptance', { method: 'POST' }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">ATUALIZAÇÃO LEGAL</span><h1>Revise para continuar</h1><p className="auth-intro">Há documentos vigentes que ainda não foram aceitos pela sua conta.</p>{error && <div className="alert">{error}</div>}<form className="auth-form" onSubmit={submit}><ul>{session.pendingLegalDocuments?.map((document) => <li key={document.id}><a href={document.url} target="_blank" rel="noreferrer">{document.title} · versão {document.version}</a></li>)}</ul><label className="auth-legal-check"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>Li e aceito os documentos acima.</span></label><Button disabled={!accepted || busy}>{busy ? 'Registrando…' : 'Aceitar e continuar'}</Button></form></Panel></AuthShell>;
}

export function ForcePasswordChangeGate({ reload }: { reload: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await json('/api/me/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">SEGURANÇA</span><h1>Crie sua senha definitiva</h1><p className="auth-intro">A senha temporária precisa ser substituída antes de continuar.</p>{error && <div className="alert">{error}</div>}<form className="auth-form" onSubmit={submit}><label><span>Senha temporária</span><input type="password" required minLength={8} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label><span>Nova senha</span><input type="password" required minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><Button disabled={busy}>{busy ? 'Salvando…' : 'Trocar senha'}</Button></form></Panel></AuthShell>;
}
