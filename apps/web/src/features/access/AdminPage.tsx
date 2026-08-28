import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

type AdminSection = 'overview' | 'tenants' | 'users' | 'operations' | 'audit' | 'health';

const sections: Array<{ key: AdminSection; label: string; icon: string }> = [
  { key: 'overview', label: 'Visão geral', icon: 'dashboard' },
  { key: 'tenants', label: 'Empresas', icon: 'chart' },
  { key: 'users', label: 'Usuários', icon: 'users' },
  { key: 'operations', label: 'Operação', icon: 'phone' },
  { key: 'audit', label: 'Auditoria', icon: 'history' },
  { key: 'health', label: 'Saúde', icon: 'settings' },
];

const fmt = (value: unknown) => new Intl.NumberFormat('pt-BR').format(Number(value ?? 0));
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString('pt-BR') : 'Nunca';
const statusLabel = (value: unknown) => ({ active: 'Ativa', blocked: 'Bloqueada', archived: 'Arquivada', connected: 'Conectado', available: 'Disponível', offline: 'Offline', in_call: 'Em chamada', post_call: 'Pós-atendimento', failed: 'Falhou', completed: 'Concluída', no_answer: 'Não atendida', cancelled: 'Cancelada', reserved: 'Reservada', dialing: 'Discando', media_active: 'Em chamada' }[String(value)] ?? String(value ?? '—'));
const statusTone = (value: unknown) => ['active', 'connected', 'online', 'ready', 'authenticated', 'available', 'completed'].includes(String(value)) ? 'success' : ['blocked', 'failed', 'disconnected', 'offline', 'archived', 'cancelled'].includes(String(value)) ? 'warning' : 'info';
const percent = (current: unknown, limit: unknown) => Math.min(100, Math.round((Number(current ?? 0) / Math.max(1, Number(limit ?? 1))) * 100));

function Metric({ label, value, hint, tone = 'blue' }: { label: string; value: unknown; hint: string; tone?: string }) {
  return <div className="metric-card admin-metric"><div className={`admin-metric-icon ${tone}`}><Icon name={tone === 'green' ? 'check' : tone === 'orange' ? 'alert' : tone === 'purple' ? 'users' : 'chart'} size={16} /></div><span>{label}</span><strong>{fmt(value)}</strong><small>{hint}</small></div>;
}

function LoadingBlock() { return <div className="admin-loading"><span /><span /><span /></div>; }

export function AdminPage({ onChanged, onOpenTenant }: { onChanged?: () => Promise<void>; onOpenTenant?: (tenantId: string) => void }) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [overview, setOverview] = useState<AnyRow>({});
  const [tenantPage, setTenantPage] = useState<AnyRow>({ items: [], total: 0 });
  const [userPage, setUserPage] = useState<AnyRow>({ items: [], total: 0 });
  const [operations, setOperations] = useState<AnyRow>({ tenants: [], recentCalls: [], numbers: [], sdrs: [] });
  const [audit, setAudit] = useState<AnyRow[]>([]);
  const [health, setHealth] = useState<AnyRow>({});
  const [scopeTenantId, setScopeTenantId] = useState('');
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantStatus, setTenantStatus] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [auditSearch, setAuditSearch] = useState('');
  const [selectedTenant, setSelectedTenant] = useState<AnyRow | null>(null);
  const [limits, setLimits] = useState({ maxLeads: '', maxNumbers: '', maxSdrs: '' });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');

  const tenants = tenantPage.items as AnyRow[];
  const users = userPage.items as AnyRow[];
  const scopeQuery = scopeTenantId ? `tenantId=${encodeURIComponent(scopeTenantId)}` : '';

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setMessage('');
    try {
      const tenantParams = new URLSearchParams({ limit: '100' });
      if (tenantSearch.trim()) tenantParams.set('search', tenantSearch.trim());
      if (tenantStatus) tenantParams.set('status', tenantStatus);
      const userParams = new URLSearchParams({ limit: '100' });
      if (userSearch.trim()) userParams.set('search', userSearch.trim());
      if (scopeTenantId) userParams.set('tenantId', scopeTenantId);
      const auditParams = new URLSearchParams({ limit: '100' });
      if (scopeTenantId) auditParams.set('tenantId', scopeTenantId);
      if (auditSearch.trim()) auditParams.set('search', auditSearch.trim());
      const [nextOverview, nextTenants, nextUsers, nextOperations, nextAudit, nextHealth] = await Promise.all([
        json(`/api/admin/overview${scopeQuery ? `?${scopeQuery}` : ''}`),
        json(`/api/admin/tenants?${tenantParams}`),
        json(`/api/admin/users?${userParams}`),
        json(`/api/admin/operations${scopeQuery ? `?${scopeQuery}` : ''}`),
        json(`/api/admin/audit?${auditParams}`),
        json('/api/admin/health'),
      ]);
      setOverview(nextOverview); setTenantPage(nextTenants); setUserPage(nextUsers); setOperations(nextOperations); setAudit(nextAudit); setHealth(nextHealth);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [scopeTenantId, scopeQuery, tenantSearch, tenantStatus, userSearch, auditSearch]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, action: () => Promise<unknown>, done: string, refreshSession = false) => {
    setBusy(key); setMessage(''); setSuccess('');
    try { await action(); setSuccess(done); await load(true); if (refreshSession) await onChanged?.(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const tenantJson = (tenantId: string, path: string, init?: RequestInit) => json(path, { ...init, headers: { ...(init?.headers ?? {}), 'x-tenant-id': tenantId } });

  const createTenant = async (event: React.FormEvent) => {
    event.preventDefault();
    await act('create-tenant', () => json('/api/tenants', { method: 'POST', body: JSON.stringify({ name, slug: slug || undefined }) }), 'Empresa criada com sucesso.', true);
    setName(''); setSlug('');
  };

  const setTenantStatusAction = async (tenant: AnyRow) => {
    const status = tenant.status === 'active' ? 'blocked' : 'active';
    if (status === 'blocked' && !window.confirm(`Bloquear ${tenant.name}? As sessões dos membros serão revogadas.`)) return;
    await act(`tenant-status-${tenant.id}`, () => json(`/api/tenants/${tenant.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }), `Empresa ${status === 'active' ? 'ativada' : 'bloqueada'}.`, true);
  };

  const openTenantDetails = async (tenantId: string) => {
    setBusy(`details-${tenantId}`); setMessage('');
    try {
      const detail = await json(`/api/admin/tenants/${tenantId}/summary`);
      setSelectedTenant(detail);
      setLimits({ maxLeads: String(detail.tenant.max_leads), maxNumbers: String(detail.tenant.max_numbers), maxSdrs: String(detail.tenant.max_sdrs) });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const saveLimits = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedTenant?.tenant?.id) return;
    const tenantId = selectedTenant.tenant.id;
    await act(`limits-${tenantId}`, () => json(`/api/tenants/${tenantId}/limits`, { method: 'PATCH', body: JSON.stringify({ maxLeads: Number(limits.maxLeads), maxNumbers: Number(limits.maxNumbers), maxSdrs: Number(limits.maxSdrs) }) }), 'Limites atualizados.');
    await openTenantDetails(tenantId);
  };

  const revokeTenantSessions = async (tenant: AnyRow) => {
    if (!window.confirm(`Encerrar todas as sessões de ${tenant.name}?`)) return;
    const reason = window.prompt('Motivo da revogação de sessões:')?.trim();
    if (!reason) return;
    await act(`tenant-sessions-${tenant.id}`, () => json(`/api/admin/tenants/${tenant.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Sessões da empresa revogadas.');
  };

  const toggleUser = async (user: AnyRow) => {
    const status = user.status === 'active' ? 'blocked' : 'active';
    if (status === 'blocked' && !window.confirm(`Bloquear ${user.name}? Todas as sessões serão encerradas.`)) return;
    await act(`user-status-${user.id}`, () => json(`/api/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }), `Usuário ${status === 'active' ? 'ativado' : 'bloqueado'}.`);
  };

  const revokeUserSessions = async (user: AnyRow) => {
    if (!window.confirm(`Encerrar as sessões ativas de ${user.name}?`)) return;
    const reason = window.prompt('Motivo da revogação de sessões:')?.trim();
    if (!reason) return;
    await act(`user-sessions-${user.id}`, () => json(`/api/admin/users/${user.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) }), 'Sessões do usuário revogadas.');
  };

  const toggleDialer = async (tenant: AnyRow) => {
    const action = tenant.dialer_running ? 'pause' : 'start';
    if (!window.confirm(`${tenant.dialer_running ? 'Pausar' : 'Iniciar'} o discador de ${tenant.name}?`)) return;
    await act(`dialer-${tenant.id}`, () => tenantJson(tenant.id, `/api/tenants/${tenant.id}/dialer/${action}`, { method: 'POST' }), `Discador de ${tenant.name} ${tenant.dialer_running ? 'pausado' : 'iniciado'}.`);
  };

  const reconnectNumber = async (number: AnyRow) => {
    if (!window.confirm(`Reconectar o número ${number.label} de ${number.tenant_name}?`)) return;
    await act(`number-${number.id}`, () => tenantJson(number.tenant_id, `/api/tenants/${number.tenant_id}/numbers/${number.id}/reconnect`, { method: 'POST' }), `Reconexão solicitada para ${number.label}.`);
  };

  const filteredTenants = useMemo(() => tenants, [tenants]);
  const metrics = overview.metrics ?? {};

  return <div className="admin-console">
    <div className="page-heading admin-heading"><div><span className="eyebrow">ADMINISTRAÇÃO DA PLATAFORMA</span><h1>Central de controle</h1><p>Empresas, acessos, operação e saúde da plataforma em um único lugar.</p></div><div className="admin-heading-actions"><select aria-label="Filtrar por empresa" value={scopeTenantId} onChange={(event) => setScopeTenantId(event.target.value)}><option value="">Todas as empresas</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select><Badge tone="purple">Admin supremo</Badge></div></div>
    <nav className="admin-tabs" aria-label="Seções administrativas">{sections.map((item) => <button type="button" key={item.key} className={section === item.key ? 'active' : ''} onClick={() => setSection(item.key)}><Icon name={item.icon} size={15} />{item.label}</button>)}</nav>
    {message && <div className="alert" role="alert"><Icon name="alert" /><span>{message}</span></div>}
    {success && <div className="import-success" role="status"><Icon name="check" /><span>{success}</span></div>}
    {loading ? <LoadingBlock /> : <>
      {section === 'overview' && <>
        <div className="metric-grid">
          <Metric label="Empresas ativas" value={metrics.tenants_active} hint={`${fmt(metrics.tenants_total)} empresas cadastradas`} />
          <Metric label="Usuários ativos" value={metrics.users_active} hint="Contas com acesso liberado" tone="purple" />
          <Metric label="Chamadas hoje" value={metrics.calls_today} hint={`${fmt(metrics.active_calls)} em andamento`} tone="green" />
          <Metric label="Falhas hoje" value={metrics.failed_calls_today} hint={`${fmt(metrics.queued_leads)} leads na fila`} tone="orange" />
          <Metric label="SDRs disponíveis" value={metrics.available_sdrs} hint="Prontos para receber chamadas" tone="green" />
          <Metric label="Números conectados" value={metrics.connected_numbers} hint={`${fmt(metrics.disconnected_numbers)} exigem atenção`} />
        </div>
        <Panel><SectionHeader title="Empresas que exigem atenção" description="Priorizadas por falhas, volume e tamanho da fila." action={<Button variant="ghost" icon="refresh" onClick={() => void load()} disabled={loading}>Atualizar</Button>} />
          <div className="admin-tenant-cards">{(overview.attention ?? []).map((tenant: AnyRow) => <article key={tenant.id} className="admin-tenant-card"><div><strong>{tenant.name}</strong><small>{tenant.slug}</small></div><Badge tone={statusTone(tenant.status)}>{statusLabel(tenant.status)}</Badge><dl><div><dt>Chamadas hoje</dt><dd>{fmt(tenant.calls_today)}</dd></div><div><dt>Falhas</dt><dd className={Number(tenant.failures_today) ? 'text-warning' : ''}>{fmt(tenant.failures_today)}</dd></div><div><dt>Fila</dt><dd>{fmt(tenant.queued_leads)}</dd></div></dl><div className="admin-card-footer"><span className={`admin-state-dot ${tenant.dialer_running ? 'on' : ''}`} />{tenant.dialer_running ? 'Discador ativo' : 'Discador pausado'}<Button variant="ghost" onClick={() => { setSection('tenants'); void openTenantDetails(tenant.id); }}>Gerenciar</Button></div></article>)}{!(overview.attention ?? []).length && <EmptyState title="Nenhuma empresa encontrada" />}</div>
        </Panel>
      </>}

      {section === 'tenants' && <>
        <Panel><SectionHeader title="Nova empresa" description="Crie uma operação isolada e configure os limites antes do uso." /><form className="form-row" onSubmit={createTenant}><input placeholder="Nome da empresa" value={name} onChange={(event) => setName(event.target.value)} required /><input placeholder="slug-opcional" value={slug} onChange={(event) => setSlug(event.target.value)} /><Button icon="plus" disabled={busy === 'create-tenant'}>{busy === 'create-tenant' ? 'Criando...' : 'Criar empresa'}</Button></form></Panel>
        <Panel><SectionHeader title="Empresas cadastradas" description={`${fmt(tenantPage.total)} registros`} action={<div className="admin-filters"><div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar empresas" placeholder="Buscar nome ou slug" value={tenantSearch} onChange={(event) => setTenantSearch(event.target.value)} /></div><select value={tenantStatus} onChange={(event) => setTenantStatus(event.target.value)}><option value="">Todos os status</option><option value="active">Ativas</option><option value="blocked">Bloqueadas</option><option value="archived">Arquivadas</option></select></div>} />
          <div className="table-scroll"><table className="admin-table"><thead><tr><th>Empresa</th><th>Uso</th><th>Números</th><th>Chamadas hoje</th><th>Status</th><th>Ações</th></tr></thead><tbody>{filteredTenants.map((tenant) => <tr key={tenant.id}><td><strong>{tenant.name}</strong><small>{tenant.slug}</small></td><td><span>{fmt(tenant.lead_count)} leads · {fmt(tenant.sdr_count)} SDRs</span></td><td><span>{fmt(tenant.connected_numbers)}/{fmt(tenant.number_count)} conectados</span></td><td>{fmt(tenant.calls_today)}</td><td><Badge tone={statusTone(tenant.status)}>{statusLabel(tenant.status)}</Badge></td><td><div className="table-actions"><Button variant="ghost" onClick={() => void openTenantDetails(tenant.id)} disabled={busy === `details-${tenant.id}`}>Detalhes</Button><Button variant="ghost" onClick={() => onOpenTenant?.(tenant.id)} disabled={tenant.status !== 'active'}>Abrir</Button><Button variant={tenant.status === 'active' ? 'danger' : 'secondary'} onClick={() => void setTenantStatusAction(tenant)} disabled={busy === `tenant-status-${tenant.id}`}>{tenant.status === 'active' ? 'Bloquear' : 'Ativar'}</Button></div></td></tr>)}</tbody></table>{!filteredTenants.length && <EmptyState title="Nenhuma empresa encontrada" description="Ajuste os filtros ou crie uma nova empresa." />}</div>
        </Panel>
        {selectedTenant && <div className="admin-drawer-backdrop" onMouseDown={() => setSelectedTenant(null)}><aside className="admin-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Detalhes da empresa"><button className="admin-drawer-close" onClick={() => setSelectedTenant(null)} aria-label="Fechar"><Icon name="close" /></button><span className="eyebrow">EMPRESA</span><h2>{selectedTenant.tenant.name}</h2><p>{selectedTenant.tenant.slug} · criada em {dateTime(selectedTenant.tenant.created_at)}</p><div className="admin-summary-grid"><div><span>Leads</span><strong>{fmt(selectedTenant.tenant.lead_count)}</strong><small>{percent(selectedTenant.tenant.lead_count, selectedTenant.tenant.max_leads)}% do limite</small></div><div><span>SDRs</span><strong>{fmt(selectedTenant.tenant.sdr_count)}</strong><small>{fmt(selectedTenant.tenant.available_sdrs)} disponíveis</small></div><div><span>Números</span><strong>{fmt(selectedTenant.tenant.number_count)}</strong><small>{fmt(selectedTenant.tenant.connected_numbers)} conectados</small></div><div><span>Chamadas hoje</span><strong>{fmt(selectedTenant.tenant.calls_today)}</strong><small>{fmt(selectedTenant.tenant.active_calls)} ativas</small></div></div><form className="admin-limit-form" onSubmit={saveLimits}><h3>Limites da empresa</h3><label>Leads<input type="number" min="1" value={limits.maxLeads} onChange={(event) => setLimits((current) => ({ ...current, maxLeads: event.target.value }))} /></label><label>Números<input type="number" min="1" value={limits.maxNumbers} onChange={(event) => setLimits((current) => ({ ...current, maxNumbers: event.target.value }))} /></label><label>SDRs<input type="number" min="1" value={limits.maxSdrs} onChange={(event) => setLimits((current) => ({ ...current, maxSdrs: event.target.value }))} /></label><Button disabled={busy === `limits-${selectedTenant.tenant.id}`}>Salvar limites</Button></form><div className="admin-drawer-section"><h3>Membros</h3>{selectedTenant.members.map((member: AnyRow) => <div className="admin-compact-row" key={member.user_id}><div><strong>{member.name}</strong><small>{member.email}</small></div><Badge tone={member.role === 'leader' ? 'purple' : 'info'}>{member.role === 'leader' ? 'Líder' : 'SDR'}</Badge></div>)}</div><div className="admin-danger-zone"><h3>Ações de segurança</h3><Button variant="danger" onClick={() => void revokeTenantSessions(selectedTenant.tenant)}>Revogar todas as sessões</Button></div></aside></div>}
      </>}

      {section === 'users' && <Panel><SectionHeader title="Usuários globais" description={`${fmt(userPage.total)} contas cadastradas`} action={<div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar usuários" placeholder="Buscar nome ou e-mail" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /></div>} /><div className="table-scroll"><table className="admin-table"><thead><tr><th>Usuário</th><th>Perfil</th><th>Empresas</th><th>Sessões</th><th>Último acesso</th><th>Ações</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td><Badge tone={user.platform_role === 'super_admin' ? 'purple' : statusTone(user.status)}>{user.platform_role === 'super_admin' ? 'Admin supremo' : statusLabel(user.status)}</Badge></td><td><div className="admin-memberships">{(user.memberships ?? []).slice(0, 2).map((membership: AnyRow) => <span key={`${user.id}-${membership.tenantId}`}>{membership.tenantName} · {membership.role}</span>)}{(user.memberships ?? []).length > 2 && <small>+{(user.memberships ?? []).length - 2} empresas</small>}</div></td><td>{fmt(user.active_sessions)}</td><td>{dateTime(user.last_login_at)}</td><td><div className="table-actions"><Button variant="ghost" onClick={() => void revokeUserSessions(user)} disabled={!Number(user.active_sessions) || busy === `user-sessions-${user.id}`}>Revogar sessões</Button><Button variant={user.status === 'active' ? 'danger' : 'secondary'} onClick={() => void toggleUser(user)} disabled={busy === `user-status-${user.id}`}>{user.status === 'active' ? 'Bloquear' : 'Ativar'}</Button></div></td></tr>)}</tbody></table>{!users.length && <EmptyState title="Nenhum usuário encontrado" />}</div></Panel>}

      {section === 'operations' && <>
        <Panel><SectionHeader title="Controle por empresa" description="Estado do discador e capacidade disponível em tempo real." /><div className="admin-operation-grid">{(operations.tenants ?? []).map((tenant: AnyRow) => <article key={tenant.id}><div className="admin-operation-title"><div><strong>{tenant.name}</strong><small>{statusLabel(tenant.status)}</small></div><Badge tone={tenant.dialer_running ? 'success' : 'warning'}>{tenant.dialer_running ? 'Discador ativo' : 'Pausado'}</Badge></div><dl><div><dt>Fila</dt><dd>{fmt(tenant.queued_leads)}</dd></div><div><dt>SDRs livres</dt><dd>{fmt(tenant.available_sdrs)}</dd></div><div><dt>Números</dt><dd>{fmt(tenant.connected_numbers)}</dd></div><div><dt>Chamadas</dt><dd>{fmt(tenant.active_calls)}</dd></div></dl><div className="panel-actions"><Button variant={tenant.dialer_running ? 'danger' : 'success'} icon={tenant.dialer_running ? 'pause' : 'play'} onClick={() => void toggleDialer(tenant)} disabled={busy === `dialer-${tenant.id}` || tenant.status !== 'active'}>{tenant.dialer_running ? 'Pausar discador' : 'Iniciar discador'}</Button><Button variant="ghost" onClick={() => onOpenTenant?.(tenant.id)}>Abrir operação</Button></div></article>)}</div></Panel>
        <div className="admin-two-columns"><Panel><SectionHeader title="Números WhatsApp" description="Desconectados aparecem primeiro." /><div className="admin-scroll-list">{(operations.numbers ?? []).map((number: AnyRow) => <div className="admin-compact-row" key={number.id}><div><strong>{number.label}</strong><small>{number.tenant_name} · {number.phone || 'sem telefone'}</small></div><Badge tone={statusTone(number.status)}>{statusLabel(number.status)}</Badge>{!['connected', 'online', 'ready', 'authenticated'].includes(String(number.status)) && <Button variant="ghost" onClick={() => void reconnectNumber(number)} disabled={busy === `number-${number.id}`}>Reconectar</Button>}</div>)}</div></Panel><Panel><SectionHeader title="SDRs" description="Estado atual das equipes." /><div className="admin-scroll-list">{(operations.sdrs ?? []).map((sdr: AnyRow) => <div className="admin-compact-row" key={sdr.id}><div><strong>{sdr.name}</strong><small>{sdr.tenant_name} · última atribuição {dateTime(sdr.last_assigned_at)}</small></div><Badge tone={statusTone(sdr.state)}>{statusLabel(sdr.state)}</Badge></div>)}</div></Panel></div>
        <Panel><SectionHeader title="Chamadas recentes" /><div className="table-scroll"><table className="admin-table"><thead><tr><th>Empresa</th><th>Lead</th><th>SDR</th><th>Número</th><th>Status</th><th>Data</th></tr></thead><tbody>{(operations.recentCalls ?? []).map((call: AnyRow) => <tr key={call.id}><td>{call.tenant_name}</td><td>{call.lead_name}</td><td>{call.sdr_name}</td><td>{call.number_label}</td><td><Badge tone={statusTone(call.status)}>{statusLabel(call.status)}</Badge></td><td>{dateTime(call.created_at)}</td></tr>)}</tbody></table></div></Panel>
      </>}

      {section === 'audit' && <Panel><SectionHeader title="Auditoria global" description="Ações administrativas e operacionais registradas pela API." action={<div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar auditoria" placeholder="Ação, pessoa ou entidade" value={auditSearch} onChange={(event) => setAuditSearch(event.target.value)} /></div>} /><div className="admin-audit-list">{audit.map((entry) => <article key={entry.id}><div className="admin-audit-icon"><Icon name="history" size={15} /></div><div><strong>{entry.action}</strong><span>{entry.actor_name ?? 'Sistema'} · {entry.tenant_name ?? 'Global'}</span><small>{entry.entity_type ? `${entry.entity_type}${entry.entity_id ? ` · ${entry.entity_id}` : ''}` : 'Ação de plataforma'}</small></div><time>{dateTime(entry.created_at)}</time></article>)}{!audit.length && <EmptyState title="Nenhum evento encontrado" />}</div></Panel>}

      {section === 'health' && <>
        <div className="admin-health-grid">{Object.entries(health.services ?? {}).map(([key, service]) => { const item = service as AnyRow; const verified = typeof item.ok === 'boolean'; const ok = item.ok === true; const label = verified ? (ok ? 'Operacional' : 'Indisponível') : 'Configurado, não verificado'; return <article key={key}><div className={`admin-health-icon ${ok || !verified ? 'ok' : 'error'}`}><Icon name={ok || !verified ? 'check' : 'alert'} /></div><div><strong>{{ api: 'API', database: 'PostgreSQL', redis: 'Redis', waxum: 'Waxum' }[key] ?? key}</strong><small>{label}{item.error ? ` · ${item.error}` : ''}</small></div><Badge tone={ok ? 'success' : verified ? 'warning' : 'neutral'}>{ok ? 'OK' : verified ? 'Erro' : 'Config.'}</Badge></article>; })}</div>
        <Panel><SectionHeader title="Informações do ambiente" description="Diagnóstico seguro, sem exposição de segredos." /><dl className="admin-environment"><div><dt>Ambiente</dt><dd>{health.environment ?? '—'}</dd></div><div><dt>Uptime</dt><dd>{fmt(health.uptimeSeconds)} segundos</dd></div><div><dt>Resposta</dt><dd>{fmt(health.responseTimeMs)} ms</dd></div><div><dt>Última migration</dt><dd>{health.latestMigration?.version ?? '—'}</dd></div><div><dt>Verificado em</dt><dd>{dateTime(health.checkedAt)}</dd></div></dl></Panel>
      </>}
    </>}
  </div>;
}
