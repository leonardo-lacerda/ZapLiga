import { FormEvent, useEffect, useState } from 'react';
import { json } from '../../services/api';
import { Button, Panel } from '../../components/ui';
import { AuthShell } from './AuthLayout';

export function AcceptInvitePage({ token, acceptInvite }: { token: string; acceptInvite: (token: string, name: string, password: string) => Promise<void> }) {
  const [preview, setPreview] = useState<any>(null); const [error, setError] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void json(`/api/invitations/${encodeURIComponent(token)}`).then(setPreview).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, [token]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await acceptInvite(token, name, password); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card">
    <div className="auth-card-head"><span className="eyebrow">CONVITE</span><span className="auth-status"><i /> Acesso seguro</span></div>
    <h1>Entrar na operação</h1>
    {preview ? <><p className="auth-intro">Você foi convidado para <strong>{preview.tenant.name}</strong> como <strong>{preview.role === 'leader' ? 'líder' : 'SDR'}</strong>.</p><form className="auth-form" onSubmit={submit}><label><span>Seu nome</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Como podemos chamar você?" autoComplete="name" required /></label><label><span>Senha <small>Mínimo de 8 caracteres</small></span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Crie uma senha segura" minLength={8} autoComplete="new-password" required /></label><Button type="submit" disabled={busy}>{busy ? 'Criando acesso...' : 'Aceitar convite'}</Button></form></> : !error ? <p className="auth-intro">Validando convite...</p> : null}
    {error && <div className="alert" role="alert">{error}</div>}
  </Panel></AuthShell>;
}
