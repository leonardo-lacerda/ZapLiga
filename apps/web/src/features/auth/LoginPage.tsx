import { FormEvent, useState } from 'react';
import { Button, Icon, Panel } from '../../components/ui';

export function LoginPage({ login, error }: { login: (email: string, password: string) => Promise<void>; error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setLocalError('');
    try { await login(email, password); } catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return <div className="auth-shell"><div className="auth-brand"><span className="brand-mark"><Icon name="phone" size={17} /></span><strong>Zap<span>Liga</span></strong></div><Panel className="auth-card"><span className="eyebrow">ACESSO SEGURO</span><h1>Entrar no ZapLiga</h1><p>Use seu e-mail e senha para acessar sua operação.</p>{(localError || error) && <div className="alert" role="alert">{localError || error}</div>}<form className="auth-form" onSubmit={submit}><label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label><Button type="submit" disabled={busy}>{busy ? 'Entrando...' : 'Entrar'}</Button></form></Panel></div>;
}
