import { FormEvent, useState } from 'react';
import { Button, Panel } from '../../components/ui';
import { AuthShell } from './AuthLayout';

export function LoginPage({ login, error }: { login: (email: string, password: string) => Promise<void>; error?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setLocalError('');
    try { await login(email, password); } catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return <AuthShell mode="login"><Panel className="auth-card">
    <div className="auth-card-head"><span className="eyebrow">ACESSO SEGURO</span><span className="auth-status"><i /> Sistema online</span></div>
    <h1>Bem-vindo de volta</h1>
    <p className="auth-intro">Entre para acompanhar sua operação e manter o time em movimento.</p>
    {(localError || error) && <div className="alert" role="alert">{localError || error}</div>}
    <form className="auth-form" onSubmit={submit}>
      <label><span>E-mail corporativo</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@empresa.com" autoComplete="email" required /></label>
      <label><span>Senha</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Digite sua senha" autoComplete="current-password" required /></label>
      <Button type="submit" disabled={busy}>{busy ? 'Entrando...' : 'Entrar na central'}</Button>
    </form>
    <div className="auth-trust"><span className="auth-trust-icon">✓</span><span>Seus dados ficam protegidos e só você acessa sua operação.</span></div>
    <div className="auth-links"><span>Primeira vez?</span><a href="/app/cadastro">Criar minha empresa</a></div>
  </Panel></AuthShell>;
}
