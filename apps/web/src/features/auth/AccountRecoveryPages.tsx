import { FormEvent, useEffect, useState } from 'react';
import { Button, Panel } from '../../components/ui';
import { json } from '../../services/api';
import { AuthShell } from './AuthLayout';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const result = await json('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }); setMessage(result.message); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">RECUPERAR ACESSO</span><h1>Esqueci minha senha</h1><p className="auth-intro">Informe seu e-mail. Se houver uma conta, você receberá um link de uso único.</p>{message && <div className="alert" role="status">{message}</div>}<form className="auth-form" onSubmit={submit}><label><span>E-mail</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><Button disabled={busy}>{busy ? 'Enviando…' : 'Enviar instruções'}</Button></form><div className="auth-links"><a href="/login">Voltar ao login</a></div></Panel></AuthShell>;
}

export function ResetPasswordPage({ token }: { token: string }) {
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [message, setMessage] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); if (password !== confirmation) { setMessage('As senhas não coincidem.'); return; } setBusy(true); try { await json('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) }); setDone(true); setMessage('Senha redefinida. Todas as sessões anteriores foram encerradas.'); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">NOVA SENHA</span><h1>Redefinir senha</h1>{message && <div className="alert" role="status">{message}</div>}{done ? <div className="auth-links"><a href="/login">Entrar com a nova senha</a></div> : <form className="auth-form" onSubmit={submit}><label><span>Nova senha</span><input type="password" minLength={8} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} /></label><label><span>Confirmar senha</span><input type="password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><Button disabled={busy || !token}>{busy ? 'Salvando…' : 'Salvar nova senha'}</Button></form>}</Panel></AuthShell>;
}

export function VerifyEmailPage({ token, onVerified }: { token: string; onVerified?: () => Promise<void> }) {
  const [message, setMessage] = useState('Verificando seu link…');
  useEffect(() => { if (!token) { setMessage('Link de verificação inválido.'); return; } void json('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) }).then(async () => { setMessage('E-mail verificado com sucesso.'); if (onVerified) await onVerified(); }).catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, [onVerified, token]);
  return <AuthShell mode="login"><Panel className="auth-card"><span className="eyebrow">VERIFICAÇÃO</span><h1>Verificar e-mail</h1><div className="alert" role="status">{message}</div><div className="auth-links"><a href="/login">Ir para o login</a></div></Panel></AuthShell>;
}

export function LegalDocumentPage({ type }: { type: 'terms' | 'privacy' }) {
  const privacy = type === 'privacy';
  return <AuthShell mode="login"><Panel className="auth-card legal-document"><span className="eyebrow">VERSÃO 2026-08-30</span><h1>{privacy ? 'Política de Privacidade' : 'Termos de Uso'}</h1><p className="auth-intro">{privacy ? 'Explica como o ZapLiga trata dados de usuários, leads e registros operacionais.' : 'Define as condições de uso responsável da plataforma ZapLiga.'}</p><p>{privacy ? 'Tratamos dados para autenticação, operação do discador, segurança, suporte e obrigações legais. O controlador da operação deve possuir base legal para os contatos importados e respeitar solicitações de não contato. Solicitações de acesso, correção ou eliminação podem ser feitas pelo canal de privacidade informado pela operação.' : 'Ao usar o ZapLiga, o usuário se compromete a manter credenciais seguras, importar apenas contatos que possam ser legitimamente tratados, respeitar horários e listas de não contato e não usar a plataforma para abuso, fraude ou chamadas ilícitas. A disponibilidade pode ser interrompida para manutenção, segurança ou cumprimento legal.'}</p><p>Vigência: 30 de agosto de 2026. O texto comercial e jurídico deve ser validado pela assessoria responsável antes da publicação definitiva.</p><div className="auth-links"><a href="/registro">Voltar</a></div></Panel></AuthShell>;
}
