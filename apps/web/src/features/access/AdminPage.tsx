import { useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

export function AdminPage({ onChanged }: { onChanged?: () => Promise<void> }) {
  const [tenants, setTenants] = useState<AnyRow[]>([]);
  const [users, setUsers] = useState<AnyRow[]>([]);
  const [audit, setAudit] = useState<AnyRow[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    try { const [nextTenants, nextUsers, nextAudit] = await Promise.all([json('/api/tenants'), json('/api/users'), json('/api/admin/audit?limit=50')]); setTenants(nextTenants); setUsers(nextUsers); setAudit(nextAudit); setMessage(''); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { void load(); }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    try { await json('/api/tenants', { method: 'POST', body: JSON.stringify({ name, slug: slug || undefined }) }); setName(''); setSlug(''); await load(); await onChanged?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const toggle = async (tenant: AnyRow) => {
    const status = tenant.status === 'active' ? 'blocked' : 'active';
    try { await json(`/api/tenants/${tenant.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); await onChanged?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const toggleUser = async (user: AnyRow) => {
    const status = user.status === 'active' ? 'blocked' : 'active';
    try { await json(`/api/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  return <><div className="page-heading"><div><span className="eyebrow">ADMINISTRAÇÃO</span><h1>Empresas</h1><p>Crie empresas, controle o status e acompanhe a auditoria global.</p></div><Badge tone="purple">Admin supremo</Badge></div>{message && <div className="alert" role="alert"><span>{message}</span></div>}<Panel><SectionHeader title="Nova empresa" description="A empresa será criada sem dados operacionais e poderá receber convites." /><form className="form-row" onSubmit={create}><input placeholder="Nome da empresa" value={name} onChange={(event) => setName(event.target.value)} required /><input placeholder="slug-opcional" value={slug} onChange={(event) => setSlug(event.target.value)} /><Button icon="plus">Criar empresa</Button></form></Panel><Panel><SectionHeader title="Empresas cadastradas" /><div className="access-list">{tenants.map((tenant) => <div className="access-row" key={tenant.id}><div><strong>{tenant.name}</strong><small>{tenant.slug} · {tenant.id}</small></div><Badge tone={tenant.status === 'active' ? 'success' : 'warning'}>{tenant.status}</Badge><Button variant="ghost" onClick={() => void toggle(tenant)}>{tenant.status === 'active' ? 'Bloquear' : 'Ativar'}</Button></div>)}</div></Panel><Panel><SectionHeader title="Usuários globais" description="Bloqueio global revoga as sessões do usuário." /><div className="access-list">{users.map((user) => <div className="access-row" key={user.id}><div><strong>{user.name}</strong><small>{user.email} · {user.platform_role}</small></div><Badge tone={user.status === 'active' ? 'success' : 'warning'}>{user.status}</Badge><Button variant="ghost" onClick={() => void toggleUser(user)}>{user.status === 'active' ? 'Bloquear' : 'Ativar'}</Button></div>)}</div></Panel><Panel><SectionHeader title="Auditoria global" description="Últimas ações administrativas registradas." /><div className="access-list">{audit.map((entry) => <div className="access-row" key={entry.id}><div><strong>{entry.action}</strong><small>{entry.actor_name ?? 'Sistema'} · {entry.tenant_name ?? 'Global'} · {new Date(entry.created_at).toLocaleString('pt-BR')}</small></div></div>)}</div></Panel></>;
}
