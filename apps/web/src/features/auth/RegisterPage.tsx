import { FormEvent, useState } from 'react';
import { Button, Icon, Panel } from '../../components/ui';

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
  return <div className="auth-shell"><div className="auth-brand"><span className="brand-mark"><Icon name="phone" size={17} /></span><strong>Zap<span>Liga</span></strong></div><Panel className="auth-card"><span className="eyebrow">COMEÇAR AGORA</span><h1>Crie sua operação</h1><p>Cadastre sua empresa e entre como organizador. Depois, você poderá convidar seus SDRs pelo painel.</p>{error && <div className="alert" role="alert">{error}</div>}<form className="auth-form" onSubmit={submit}><label>Seu nome<input value={form.name} onChange={(event) => update('name', event.target.value)} autoComplete="name" required /></label><label>E-mail<input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} autoComplete="email" required /></label><label>Senha<input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} minLength={8} autoComplete="new-password" required /></label><label>Nome da empresa<input value={form.companyName} onChange={(event) => update('companyName', event.target.value)} autoComplete="organization" required /></label><label>Slug da empresa <span className="field-hint">opcional</span><input value={form.companySlug} onChange={(event) => update('companySlug', event.target.value)} placeholder="minha-empresa" /></label><Button type="submit" disabled={busy}>{busy ? 'Criando operação...' : 'Criar operação'}</Button></form><div className="auth-links"><span>Já possui uma conta?</span><a href="/app/">Entrar</a></div></Panel></div>;
}
