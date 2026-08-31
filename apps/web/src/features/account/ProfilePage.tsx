import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import type { AuthSession } from '../auth/AuthProvider';

const deviceName = (agent: string) => {
  if (!agent) return 'Dispositivo desconhecido';
  const browser = agent.includes('Edg/') ? 'Edge' : agent.includes('Chrome/') ? 'Chrome' : agent.includes('Firefox/') ? 'Firefox' : agent.includes('Safari/') ? 'Safari' : 'Navegador';
  const system = agent.includes('Windows') ? 'Windows' : agent.includes('Mac OS') ? 'macOS' : agent.includes('Android') ? 'Android' : agent.includes('iPhone') ? 'iPhone' : 'Dispositivo';
  return `${browser} em ${system}`;
};

export function ProfilePage({ session, reload, logout }: { session: AuthSession; reload: () => Promise<void>; logout: () => Promise<void> }) {
  const [name, setName] = useState(session.user.name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sessions, setSessions] = useState<AnyRow[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const loadSessions = useCallback(async () => { try { setSessions(await json('/api/me/sessions')); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } }, []);
  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const saveProfile = async (event: FormEvent) => { event.preventDefault(); setBusy('profile'); try { await json('/api/me/profile', { method: 'PATCH', body: JSON.stringify({ name }) }); setMessage('Perfil atualizado.'); await reload(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(''); } };
  const changePassword = async (event: FormEvent) => { event.preventDefault(); setBusy('password'); try { await json('/api/me/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }); setCurrentPassword(''); setNewPassword(''); setMessage('Senha alterada e outras sessões encerradas.'); await loadSessions(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(''); } };
  const resendVerification = async () => { setBusy('verification'); try { const result = await json('/api/auth/email/resend-verification', { method: 'POST', body: JSON.stringify({ email: session.user.email }) }); setMessage(result.message); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(''); } };
  const revoke = async (item: AnyRow) => { if (!window.confirm(`Encerrar a sessão “${deviceName(item.user_agent)}”?`)) return; try { await json(`/api/me/sessions/${item.id}`, { method: 'DELETE' }); if (item.current) await logout(); else { setMessage('Sessão encerrada.'); await loadSessions(); } } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } };

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">CONTA</span><h1>Meu perfil</h1><p>Atualize seus dados, sua senha e os dispositivos com acesso.</p></div>
      <Badge tone={session.user.emailVerifiedAt ? 'success' : 'warning'}>{session.user.emailVerifiedAt ? 'E-mail verificado' : 'E-mail pendente'}</Badge>
    </div>
    {!session.user.emailVerifiedAt && <div className="alert" role="status"><span>Seu e-mail ainda não foi verificado.</span><Button variant="ghost" disabled={busy === 'verification'} onClick={() => void resendVerification()}>{busy === 'verification' ? 'Enviando…' : 'Reenviar verificação'}</Button></div>}
    {message && <div className="alert" role="status"><span>{message}</span><button onClick={() => setMessage('')}>×</button></div>}
    <div className="profile-grid">
      <Panel><SectionHeader title="Dados pessoais" /><form className="auth-form compact-form" onSubmit={saveProfile}><label><span>Nome</span><input value={name} required minLength={2} onChange={(event) => setName(event.target.value)} /></label><label><span>E-mail</span><input value={session.user.email} disabled /></label><Button disabled={busy === 'profile'}>{busy === 'profile' ? 'Salvando…' : 'Salvar perfil'}</Button></form></Panel>
      <Panel><SectionHeader title="Alterar senha" description="As demais sessões serão encerradas imediatamente." /><form className="auth-form compact-form" onSubmit={changePassword}><label><span>Senha atual</span><input type="password" minLength={8} required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label><span>Nova senha</span><input type="password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label><Button disabled={busy === 'password'}>{busy === 'password' ? 'Alterando…' : 'Alterar senha'}</Button></form></Panel>
    </div>
    <Panel><SectionHeader title="Sessões e dispositivos" description="Encerre imediatamente qualquer acesso que não reconhecer." /><div className="access-list">{sessions.map((item) => <div className="access-row" key={item.id}><div><strong>{deviceName(item.user_agent)}</strong><small>{item.ip_address || 'IP não informado'} · acesso em {new Date(item.created_at).toLocaleString('pt-BR')}</small></div>{item.current && <Badge tone="success">Esta sessão</Badge>}<Button variant="ghost" onClick={() => void revoke(item)}>Encerrar</Button></div>)}{!sessions.length && <EmptyState title="Nenhuma sessão ativa" />}</div></Panel>
  </>;
}
