import { FormEvent, useState } from 'react';
import { Button, Panel } from '../../components/ui';
import { AuthShell } from './AuthLayout';

type RegisterInput = { name: string; email: string; password: string; companyName: string; companySlug?: string };

export function RegisterPage({ register }: { register: (input: RegisterInput) => Promise<void> }) {
  const [form, setForm] = useState<RegisterInput>({ name: '', email: '', password: '', companyName: '', companySlug: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = (field: keyof RegisterInput, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await register({ ...form, companySlug: form.companySlug || undefined }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <AuthShell mode="register"><Panel className="auth-card auth-card-register">
    <div className="auth-card-head"><span className="eyebrow">COMEÇAR AGORA</span><span className="auth-step">PASSO 1 DE 1</span></div>
    <h1>Crie sua operação</h1>
    <p className="auth-intro">Cadastre sua empresa e comece a organizar seu time comercial em minutos.</p>
    {error && <div className="alert" role="alert">{error}</div>}
    <form className="auth-form auth-form-register" onSubmit={submit}>
      <label><span>Seu nome</span><input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="Como podemos chamar você?" autoComplete="name" required /></label>
      <label><span>E-mail corporativo</span><input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="voce@empresa.com" autoComplete="email" required /></label>
      <label><span>Senha <small>Mínimo de 8 caracteres</small></span><input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} placeholder="Crie uma senha segura" minLength={8} autoComplete="new-password" required /></label>
      <label><span>Nome da empresa</span><input value={form.companyName} onChange={(event) => update('companyName', event.target.value)} placeholder="Ex.: Acme Comercial" autoComplete="organization" required /></label>
      <label className="auth-field-wide"><span>Slug da empresa <small>Opcional · usado no endereço da operação</small></span><input value={form.companySlug} onChange={(event) => update('companySlug', event.target.value)} placeholder="minha-empresa" /></label>
      <Button type="submit" disabled={busy}>{busy ? 'Criando operação...' : 'Criar minha operação'}</Button>
    </form>
    <div className="auth-links"><span>Já possui uma conta?</span><a href="/login">Entrar</a></div>
  </Panel></AuthShell>;
}
