import { FormEvent, useEffect, useState } from 'react';
import { json } from '../../services/api';
import { Button, Icon, Panel } from '../../components/ui';

export function AcceptInvitePage({ token, acceptInvite }: { token: string; acceptInvite: (token: string, name: string, password: string) => Promise<void> }) {
  const [preview, setPreview] = useState<any>(null); const [error, setError] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void json(`/api/invitations/${encodeURIComponent(token)}`).then(setPreview).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, [token]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await acceptInvite(token, name, password); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <div className="auth-shell"><div className="auth-brand"><span className="brand-mark"><Icon name="phone" size={17} /></span><strong>Zap<span>Call</span></strong></div><Panel className="auth-card"><span className="eyebrow">CONVITE</span><h1>Entrar na operação</h1>{preview ? <><p>Você foi convidado para <strong>{preview.tenant.name}</strong> como <strong>{preview.role === 'leader' ? 'líder' : 'SDR'}</strong>.</p><form className="auth-form" onSubmit={submit}><label>Seu nome<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></label><Button type="submit" disabled={busy}>{busy ? 'Criando acesso...' : 'Aceitar convite'}</Button></form></> : !error ? <p>Validando convite...</p> : null}{error && <div className="alert" role="alert">{error}</div>}</Panel></div>;
}
