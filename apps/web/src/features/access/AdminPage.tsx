import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, EmptyState, Icon, Pagination, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import { PAGE_SIZE, formatNumber } from '../../shared/format';
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

const fmt = formatNumber;
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
  const [auditPage, setAuditPage] = useState<AnyRow>({ items: [], total: 0 });
  const [health, setHealth] = useState<AnyRow>({});
  const [scopeTenantId, setScopeTenantId] = useState('');
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantStatus, setTenantStatus] = useState('');
  const [tenantOffset, setTenantOffset] = useState(0);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [userStatusFilter, setUserStatusFilter] = useState('');
  const [userOffset, setUserOffset] = useState(0);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'sdr' | 'leader'>('sdr');
  const [auditSearch, setAuditSearch] = useState('');
  const [auditOffset, setAuditOffset] = useState(0);
  const [selectedTenant, setSelectedTenant] = useState<AnyRow | null>(null);
  const [tenantNumbers, setTenantNumbers] = useState<AnyRow>({ items: [], total: 0 });
  const [tenantHistory, setTenantHistory] = useState<AnyRow[]>([]);
  const [noteBody, setNoteBody] = useState('');
  const [notePinned, setNotePinned] = useState(false);
  const [bulkPasswords, setBulkPasswords] = useState<AnyRow[]>([]);
  const [limits, setLimits] = useState({ maxLeads: '', maxNumbers: '', maxSdrs: '' });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');

  const tenants = tenantPage.items as AnyRow[];
  const users = userPage.items as AnyRow[];
  const audit = auditPage.items as AnyRow[];
  const scopeQuery = scopeTenantId ? `tenantId=${encodeURIComponent(scopeTenantId)}` : '';

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setMessage('');
    try {
      const tenantParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(tenantOffset) });
      if (tenantSearch.trim()) tenantParams.set('search', tenantSearch.trim());
      if (tenantStatus) tenantParams.set('status', tenantStatus);
      const userParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(userOffset) });
      if (userSearch.trim()) userParams.set('search', userSearch.trim());
      if (scopeTenantId) userParams.set('tenantId', scopeTenantId);
      if (userRoleFilter) userParams.set('role', userRoleFilter);
      if (userStatusFilter) userParams.set('status', userStatusFilter);
      const auditParams = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(auditOffset) });
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
      setOverview(nextOverview); setTenantPage(nextTenants); setUserPage(nextUsers); setOperations(nextOperations); setAuditPage(nextAudit); setHealth(nextHealth);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, [scopeTenantId, scopeQuery, tenantSearch, tenantStatus, tenantOffset, userSearch, userRoleFilter, userStatusFilter, userOffset, auditSearch, auditOffset]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setTenantOffset(0); }, [tenantSearch, tenantStatus]);
  useEffect(() => { setUserOffset(0); }, [userSearch, userRoleFilter, userStatusFilter, scopeTenantId]);
  useEffect(() => { setAuditOffset(0); }, [auditSearch, scopeTenantId]);

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

  const setTenantStatusAction = async (tenant: AnyRow, status: 'active' | 'blocked' | 'archived') => {
    if (status === tenant.status) return;
    const label = status === 'active' ? 'ativar' : status === 'blocked' ? 'bloquear' : 'arquivar';
    if (status !== 'active' && !window.confirm(`Confirma ${label} ${tenant.name}? As sessões dos membros serão revogadas.`)) return;
    await act(`tenant-status-${tenant.id}`, () => json(`/api/tenants/${tenant.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }), `Empresa ${status === 'active' ? 'ativada' : status === 'blocked' ? 'bloqueada' : 'arquivada'}.`, true);
  };

  const openTenantDetails = async (tenantId: string) => {
    setBusy(`details-${tenantId}`); setMessage('');
    try {
      const [detail, numbers, history] = await Promise.all([
        json(`/api/admin/tenants/${tenantId}/summary`),
        json(`/api/admin/tenants/${tenantId}/numbers?limit=50`),
        json(`/api/admin/audit?tenantId=${encodeURIComponent(tenantId)}&limit=20`),
      ]);
      setSelectedTenant(detail);
      setTenantNumbers(numbers);
      setTenantHistory(history.items ?? []);
      setLimits({ maxLeads: String(detail.tenant.max_leads), maxNumbers: String(detail.tenant.max_numbers), maxSdrs: String(detail.tenant.max_sdrs) });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedTenant?.tenant?.id) return;
    const tenantId = selectedTenant.tenant.id;
    await act(`note-add-${tenantId}`, () => json(`/api/admin/tenants/${tenantId}/notes`, { method: 'POST', body: JSON.stringify({ body: noteBody, pinned: notePinned }) }), 'Nota adicionada.');
    setNoteBody(''); setNotePinned(false);
    await openTenantDetails(tenantId);
  };

  const removeNote = async (tenantId: string, noteId: string) => {
    if (!window.confirm('Remover esta nota?')) return;
    await act(`note-remove-${noteId}`, () => json(`/api/admin/tenants/${tenantId}/notes/${noteId}`, { method: 'DELETE' }), 'Nota removida.');
    await openTenantDetails(tenantId);
  };

  const reconnectNumberInTenant = async (tenantId: string, number: AnyRow) => {
    if (!window.confirm(`Reconectar o número ${number.label}?`)) return;
    await act(`number-reconnect-${number.id}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/numbers/${number.id}/reconnect`, { method: 'POST' }), `Reconexão solicitada para ${number.label}.`);
    await openTenantDetails(tenantId);
  };

  const removeNumberInTenant = async (tenantId: string, number: AnyRow) => {
    if (!window.confirm(`Remover o número ${number.label}? Essa ação não pode ser desfeita.`)) return;
    await act(`number-remove-${number.id}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/numbers/${number.id}`, { method: 'DELETE' }), `${number.label} removido.`);
    await openTenantDetails(tenantId);
  };

  const unlockNumber = async (tenantId: string, number: AnyRow) => {
    if (!window.confirm(`Destravar ${number.label}? Isso limpa quarentena e cooldown para permitir discar imediatamente.`)) return;
    setBusy(`number-unlock-${number.id}`); setMessage(''); setSuccess('');
    try {
      await json(`/api/admin/tenants/${tenantId}/numbers/${number.id}/clear-quarantine`, { method: 'POST' });
      await json(`/api/admin/tenants/${tenantId}/numbers/${number.id}/clear-cooldown`, { method: 'POST' });
      setSuccess(`${number.label} destravado.`);
      await load(true);
      if (selectedTenant?.tenant?.id === tenantId) await openTenantDetails(tenantId);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const forceFinishCall = async (tenantId: string, call: AnyRow, confirmActiveOwner = false) => {
    if (!confirmActiveOwner && !window.confirm(`Forçar encerramento da chamada de ${call.lead_name}?`)) return;
    setBusy(`call-finish-${call.id}`); setMessage(''); setSuccess('');
    try {
      await json(`/api/admin/tenants/${tenantId}/calls/${call.id}/force-finish`, { method: 'POST', body: JSON.stringify({ confirmActiveOwner }) });
      setSuccess(`Chamada de ${call.lead_name} encerrada.`);
      await load(true);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (!confirmActiveOwner && messageText.includes('ainda está ativa')) {
        if (window.confirm(`${messageText}\n\nForçar mesmo assim?`)) { setBusy(''); await forceFinishCall(tenantId, call, true); return; }
      } else setMessage(messageText);
    } finally { setBusy(''); }
  };

  const forceReleaseSdr = async (tenantId: string, sdr: AnyRow, confirmActiveOwner = false) => {
    if (!confirmActiveOwner && !window.confirm(`Forçar ${sdr.name} de volta para disponível? Isso encerra qualquer chamada ativa e pula o pós-atendimento pendente.`)) return;
    setBusy(`sdr-force-${sdr.id}`); setMessage(''); setSuccess('');
    try {
      await json(`/api/admin/tenants/${tenantId}/sdrs/${sdr.id}/force-available`, { method: 'POST', body: JSON.stringify({ confirmActiveOwner }) });
      setSuccess(`${sdr.name} disponível novamente.`);
      await load(true);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (!confirmActiveOwner && messageText.includes('ainda está ativa')) {
        if (window.confirm(`${messageText}\n\nForçar mesmo assim?`)) { setBusy(''); await forceReleaseSdr(tenantId, sdr, true); return; }
      } else setMessage(messageText);
    } finally { setBusy(''); }
  };

  const emergencyStop = async (tenant: AnyRow) => {
    if (!window.confirm(`Parada de emergência para ${tenant.name}? Isso pausa o discador e revoga todas as sessões ativas.`)) return;
    const reason = window.prompt('Motivo da parada de emergência:')?.trim();
    if (!reason) return;
    setBusy(`emergency-${tenant.id}`); setMessage(''); setSuccess('');
    try {
      await tenantJson(tenant.id, `/api/tenants/${tenant.id}/dialer/pause`, { method: 'POST' });
      await json(`/api/admin/tenants/${tenant.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason }) });
      setSuccess(`Parada de emergência aplicada em ${tenant.name}.`);
      await load(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const bulkResetPasswords = async (tenant: AnyRow) => {
    if (!window.confirm(`Gerar novas senhas temporárias para todos os líderes de ${tenant.name}? As sessões deles serão encerradas.`)) return;
    setBusy(`bulk-reset-${tenant.id}`); setMessage(''); setSuccess('');
    try {
      const results = await json(`/api/admin/tenants/${tenant.id}/leaders/reset-passwords`, { method: 'POST' });
      setBulkPasswords(results);
      await load(true);
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

  const createMembership = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedTenant?.tenant?.id) return;
    const tenantId = selectedTenant.tenant.id;
    await act(`member-create-${tenantId}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/members`, { method: 'POST', body: JSON.stringify({ email: memberEmail, role: memberRole }) }), 'Membro adicionado à empresa.');
    setMemberEmail('');
    await openTenantDetails(tenantId);
  };

  const toggleMembershipStatus = async (tenantId: string, member: AnyRow) => {
    const status = member.status === 'active' ? 'blocked' : 'active';
    if (status === 'blocked' && !window.confirm(`Bloquear ${member.name} nesta empresa?`)) return;
    await act(`member-status-${member.user_id}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/members/${member.user_id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }), `Membro ${status === 'active' ? 'ativado' : 'bloqueado'}.`);
    await openTenantDetails(tenantId);
  };

  const toggleMembershipRole = async (tenantId: string, member: AnyRow) => {
    const role = member.role === 'leader' ? 'sdr' : 'leader';
    if (!window.confirm(`Alterar papel de ${member.name} para ${role === 'leader' ? 'Líder' : 'SDR'}?`)) return;
    await act(`member-role-${member.user_id}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/members/${member.user_id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }), 'Papel do membro atualizado.');
    await openTenantDetails(tenantId);
  };

  const removeMembership = async (tenantId: string, member: AnyRow) => {
    if (!window.confirm(`Remover ${member.name} desta empresa?`)) return;
    await act(`member-remove-${member.user_id}`, () => tenantJson(tenantId, `/api/tenants/${tenantId}/members/${member.user_id}`, { method: 'DELETE' }), 'Membro removido da empresa.');
    await openTenantDetails(tenantId);
  };

  const revokeTenantSessionsByRole = async (tenant: AnyRow, role?: 'leader' | 'sdr') => {
    const label = role === 'leader' ? 'líderes' : role === 'sdr' ? 'SDRs' : 'todos os membros';
    if (!window.confirm(`Encerrar sessões de ${label} de ${tenant.name}?`)) return;
    const reason = window.prompt('Motivo da revogação de sessões:')?.trim();
    if (!reason) return;
    await act(`tenant-sessions-${tenant.id}-${role ?? 'all'}`, () => json(`/api/admin/tenants/${tenant.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({ reason, role }) }), `Sessões (${label}) revogadas.`);
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

  const resetUserPassword = async (user: AnyRow) => {
    if (!window.confirm(`Gerar uma nova senha temporária para ${user.name}? As sessões ativas serão encerradas.`)) return;
    setBusy(`user-reset-${user.id}`); setMessage(''); setSuccess('');
    try {
      const result = await json(`/api/users/${user.id}/reset-password`, { method: 'POST' });
      setSuccess(`Senha temporária de ${user.name}: ${result.temporaryPassword} — copie agora, ela não será exibida novamente.`);
      await load(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const toggleSuperAdmin = async (user: AnyRow) => {
    const platformRole = user.platform_role === 'super_admin' ? 'user' : 'super_admin';
    const verb = platformRole === 'super_admin' ? 'promover a Admin supremo' : 'remover o acesso de Admin supremo de';
    if (!window.confirm(`Confirma ${verb} ${user.name}?`)) return;
    await act(`user-role-${user.id}`, () => json(`/api/users/${user.id}/platform-role`, { method: 'PATCH', body: JSON.stringify({ platformRole }) }), `Perfil de ${user.name} atualizado.`);
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
          <div className="table-scroll"><table className="admin-table"><thead><tr><th>Empresa</th><th>Uso</th><th>Números</th><th>Chamadas hoje</th><th>Status</th><th>Ações</th></tr></thead><tbody>{filteredTenants.map((tenant) => <tr key={tenant.id}><td><strong>{tenant.name}</strong><small>{tenant.slug}</small></td><td><span>{fmt(tenant.lead_count)} leads · {fmt(tenant.sdr_count)} SDRs</span></td><td><span>{fmt(tenant.connected_numbers)}/{fmt(tenant.number_count)} conectados</span></td><td>{fmt(tenant.calls_today)}</td><td><Badge tone={statusTone(tenant.status)}>{statusLabel(tenant.status)}</Badge></td><td><div className="table-actions"><Button variant="ghost" onClick={() => void openTenantDetails(tenant.id)} disabled={busy === `details-${tenant.id}`}>Detalhes</Button><Button variant="ghost" onClick={() => onOpenTenant?.(tenant.id)} disabled={tenant.status !== 'active'}>Abrir</Button>{tenant.status !== 'active' && <Button variant="secondary" onClick={() => void setTenantStatusAction(tenant, 'active')} disabled={busy === `tenant-status-${tenant.id}`}>Ativar</Button>}{tenant.status !== 'blocked' && <Button variant="danger" onClick={() => void setTenantStatusAction(tenant, 'blocked')} disabled={busy === `tenant-status-${tenant.id}`}>Bloquear</Button>}{tenant.status !== 'archived' && <Button variant="ghost" icon="archive" onClick={() => void setTenantStatusAction(tenant, 'archived')} disabled={busy === `tenant-status-${tenant.id}`}>Arquivar</Button>}</div></td></tr>)}</tbody></table>{!filteredTenants.length && <EmptyState title="Nenhuma empresa encontrada" description="Ajuste os filtros ou crie uma nova empresa." />}</div>
          <Pagination offset={tenantOffset} limit={PAGE_SIZE} total={tenantPage.total} onChange={setTenantOffset} />
        </Panel>
        {selectedTenant && <div className="admin-drawer-backdrop" onMouseDown={() => setSelectedTenant(null)}><aside className="admin-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Detalhes da empresa"><button className="admin-drawer-close" onClick={() => setSelectedTenant(null)} aria-label="Fechar"><Icon name="close" /></button><span className="eyebrow">EMPRESA</span><h2>{selectedTenant.tenant.name}</h2><p>{selectedTenant.tenant.slug} · criada em {dateTime(selectedTenant.tenant.created_at)}</p><div className="admin-summary-grid"><div><span>Leads</span><strong>{fmt(selectedTenant.tenant.lead_count)}</strong><small>{percent(selectedTenant.tenant.lead_count, selectedTenant.tenant.max_leads)}% do limite</small></div><div><span>SDRs</span><strong>{fmt(selectedTenant.tenant.sdr_count)}</strong><small>{fmt(selectedTenant.tenant.available_sdrs)} disponíveis</small></div><div><span>Números</span><strong>{fmt(selectedTenant.tenant.number_count)}</strong><small>{fmt(selectedTenant.tenant.connected_numbers)} conectados</small></div><div><span>Chamadas hoje</span><strong>{fmt(selectedTenant.tenant.calls_today)}</strong><small>{fmt(selectedTenant.tenant.active_calls)} ativas</small></div></div><form className="admin-limit-form" onSubmit={saveLimits}><h3>Limites da empresa</h3><label>Leads<input type="number" min="1" value={limits.maxLeads} onChange={(event) => setLimits((current) => ({ ...current, maxLeads: event.target.value }))} /></label><label>Números<input type="number" min="1" value={limits.maxNumbers} onChange={(event) => setLimits((current) => ({ ...current, maxNumbers: event.target.value }))} /></label><label>SDRs<input type="number" min="1" value={limits.maxSdrs} onChange={(event) => setLimits((current) => ({ ...current, maxSdrs: event.target.value }))} /></label><Button disabled={busy === `limits-${selectedTenant.tenant.id}`}>Salvar limites</Button></form><div className="admin-drawer-section"><h3>Membros</h3><form className="form-row" onSubmit={createMembership}><input type="email" placeholder="e-mail de um usuário existente" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} required /><select value={memberRole} onChange={(event) => setMemberRole(event.target.value as 'sdr' | 'leader')}><option value="sdr">SDR</option><option value="leader">Líder</option></select><Button icon="plus" disabled={busy === `member-create-${selectedTenant.tenant.id}`}>Adicionar</Button></form>{selectedTenant.members.map((member: AnyRow) => <div className="admin-compact-row" key={member.user_id}><div><strong>{member.name}</strong><small>{member.email}</small></div><Badge tone={member.role === 'leader' ? 'purple' : 'info'}>{member.role === 'leader' ? 'Líder' : 'SDR'}</Badge><Badge tone={member.status === 'active' ? 'success' : 'warning'}>{member.status === 'active' ? 'Ativo' : 'Bloqueado'}</Badge><div className="table-actions"><Button variant="ghost" onClick={() => void toggleMembershipRole(selectedTenant.tenant.id, member)} disabled={busy === `member-role-${member.user_id}`}>{member.role === 'leader' ? 'Tornar SDR' : 'Tornar líder'}</Button><Button variant="ghost" onClick={() => void toggleMembershipStatus(selectedTenant.tenant.id, member)} disabled={busy === `member-status-${member.user_id}`}>{member.status === 'active' ? 'Bloquear' : 'Ativar'}</Button><Button variant="danger" onClick={() => void removeMembership(selectedTenant.tenant.id, member)} disabled={busy === `member-remove-${member.user_id}`}>Remover</Button></div></div>)}{!selectedTenant.members.length && <p className="text-muted">Nenhum membro cadastrado.</p>}</div><div className="admin-drawer-section"><h3>Números</h3><div className="admin-scroll-list">{(tenantNumbers.items ?? []).map((number: AnyRow) => <div className="admin-compact-row" key={number.id}><div><strong>{number.label}</strong><small>{number.phone || 'sem telefone'}</small></div><Badge tone={statusTone(number.status)}>{statusLabel(number.status)}</Badge>{Boolean(number.flagged) && <Badge tone="warning">Quarentena {Math.ceil(Number(number.quarantine_seconds_remaining ?? 0) / 60)}min</Badge>}{!number.flagged && Number(number.cooldown_seconds_remaining ?? 0) > 0 && <Badge tone="info">Cooldown {number.cooldown_seconds_remaining}s</Badge>}<div className="table-actions">{(Boolean(number.flagged) || Number(number.cooldown_seconds_remaining ?? 0) > 0) && <Button variant="ghost" icon="unlock" onClick={() => void unlockNumber(selectedTenant.tenant.id, number)} disabled={busy === `number-unlock-${number.id}`}>Destravar</Button>}<Button variant="ghost" onClick={() => void reconnectNumberInTenant(selectedTenant.tenant.id, number)} disabled={busy === `number-reconnect-${number.id}` || selectedTenant.tenant.status !== 'active'}>Reconectar</Button><Button variant="danger" onClick={() => void removeNumberInTenant(selectedTenant.tenant.id, number)} disabled={busy === `number-remove-${number.id}` || selectedTenant.tenant.status !== 'active'}>Remover</Button></div></div>)}{!tenantNumbers.items?.length && <p className="text-muted">Nenhum número cadastrado.</p>}</div></div><div className="admin-drawer-section"><h3>Notas internas</h3><form className="form-row" onSubmit={addNote}><input placeholder="Anotação sobre esta empresa" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} required /><label className="admin-inline-checkbox"><input type="checkbox" checked={notePinned} onChange={(event) => setNotePinned(event.target.checked)} /> Fixar</label><Button icon="note" disabled={busy === `note-add-${selectedTenant.tenant.id}`}>Adicionar</Button></form>{(selectedTenant.notes ?? []).map((note: AnyRow) => <div className="admin-compact-row" key={note.id}><div>{Boolean(note.pinned) && <Badge tone="purple">Fixada</Badge>}<strong>{note.author_name ?? 'Sistema'}</strong><small>{dateTime(note.created_at)} · {note.body}</small></div><Button variant="ghost" onClick={() => void removeNote(selectedTenant.tenant.id, note.id)} disabled={busy === `note-remove-${note.id}`}>Remover</Button></div>)}{!selectedTenant.notes?.length && <p className="text-muted">Nenhuma nota registrada.</p>}</div><div className="admin-drawer-section"><h3>Histórico</h3><div className="admin-audit-list">{tenantHistory.map((entry: AnyRow) => <article key={entry.id}><div className="admin-audit-icon"><Icon name="history" size={15} /></div><div><strong>{entry.action}</strong><span>{entry.actor_name ?? 'Sistema'}</span></div><time>{dateTime(entry.created_at)}</time></article>)}{!tenantHistory.length && <p className="text-muted">Nenhum evento registrado.</p>}</div></div><div className="admin-danger-zone"><h3>Ações de segurança</h3><Button variant="danger" icon="alert" onClick={() => void emergencyStop(selectedTenant.tenant)} disabled={busy === `emergency-${selectedTenant.tenant.id}` || selectedTenant.tenant.status !== 'active'}>Parada de emergência</Button><div className="table-actions"><Button variant="ghost" onClick={() => void revokeTenantSessionsByRole(selectedTenant.tenant)} disabled={busy === `tenant-sessions-${selectedTenant.tenant.id}-all`}>Revogar sessões (todas)</Button><Button variant="ghost" onClick={() => void revokeTenantSessionsByRole(selectedTenant.tenant, 'leader')} disabled={busy === `tenant-sessions-${selectedTenant.tenant.id}-leader`}>Revogar sessões (líderes)</Button><Button variant="ghost" onClick={() => void revokeTenantSessionsByRole(selectedTenant.tenant, 'sdr')} disabled={busy === `tenant-sessions-${selectedTenant.tenant.id}-sdr`}>Revogar sessões (SDRs)</Button></div><Button variant="danger" onClick={() => void bulkResetPasswords(selectedTenant.tenant)} disabled={busy === `bulk-reset-${selectedTenant.tenant.id}`}>Redefinir senha de todos os líderes</Button>{bulkPasswords.length > 0 && <div className="import-success" role="status"><Icon name="check" /><div><strong>Copie agora — não será exibido novamente:</strong>{bulkPasswords.map((entry) => <div key={entry.userId}>{entry.name} ({entry.email}): <code>{entry.temporaryPassword}</code></div>)}<Button variant="ghost" onClick={() => setBulkPasswords([])}>Fechar</Button></div></div>}</div></aside></div>}
      </>}

      {section === 'users' && <Panel><SectionHeader title="Usuários globais" description={`${fmt(userPage.total)} contas cadastradas`} action={<div className="admin-filters"><div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar usuários" placeholder="Buscar nome ou e-mail" value={userSearch} onChange={(event) => setUserSearch(event.target.value)} /></div><select aria-label="Filtrar por perfil" value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value)}><option value="">Todos os perfis</option><option value="user">Usuário</option><option value="super_admin">Admin supremo</option></select><select aria-label="Filtrar por status" value={userStatusFilter} onChange={(event) => setUserStatusFilter(event.target.value)}><option value="">Todos os status</option><option value="active">Ativos</option><option value="blocked">Bloqueados</option></select></div>} /><div className="table-scroll"><table className="admin-table"><thead><tr><th>Usuário</th><th>Perfil</th><th>Empresas</th><th>Sessões</th><th>Último acesso</th><th>Ações</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.name}</strong><small>{user.email}</small></td><td><Badge tone={user.platform_role === 'super_admin' ? 'purple' : statusTone(user.status)}>{user.platform_role === 'super_admin' ? 'Admin supremo' : statusLabel(user.status)}</Badge></td><td><div className="admin-memberships">{(user.memberships ?? []).slice(0, 2).map((membership: AnyRow) => <span key={`${user.id}-${membership.tenantId}`}>{membership.tenantName} · {membership.role}</span>)}{(user.memberships ?? []).length > 2 && <small>+{(user.memberships ?? []).length - 2} empresas</small>}</div></td><td>{fmt(user.active_sessions)}</td><td>{dateTime(user.last_login_at)}</td><td><div className="table-actions"><Button variant="ghost" onClick={() => void revokeUserSessions(user)} disabled={!Number(user.active_sessions) || busy === `user-sessions-${user.id}`}>Revogar sessões</Button><Button variant="ghost" onClick={() => void resetUserPassword(user)} disabled={busy === `user-reset-${user.id}`}>Redefinir senha</Button><Button variant="ghost" onClick={() => void toggleSuperAdmin(user)} disabled={busy === `user-role-${user.id}`}>{user.platform_role === 'super_admin' ? 'Remover admin supremo' : 'Promover a admin supremo'}</Button><Button variant={user.status === 'active' ? 'danger' : 'secondary'} onClick={() => void toggleUser(user)} disabled={busy === `user-status-${user.id}`}>{user.status === 'active' ? 'Bloquear' : 'Ativar'}</Button></div></td></tr>)}</tbody></table>{!users.length && <EmptyState title="Nenhum usuário encontrado" />}<Pagination offset={userOffset} limit={PAGE_SIZE} total={userPage.total} onChange={setUserOffset} /></div></Panel>}

      {section === 'operations' && <>
        <Panel><SectionHeader title="Controle por empresa" description="Estado do discador e capacidade disponível em tempo real." /><div className="admin-operation-grid">{(operations.tenants ?? []).map((tenant: AnyRow) => <article key={tenant.id}><div className="admin-operation-title"><div><strong>{tenant.name}</strong><small>{statusLabel(tenant.status)}</small></div><Badge tone={tenant.dialer_running ? 'success' : 'warning'}>{tenant.dialer_running ? 'Discador ativo' : 'Pausado'}</Badge></div><dl><div><dt>Fila</dt><dd>{fmt(tenant.queued_leads)}</dd></div><div><dt>SDRs livres</dt><dd>{fmt(tenant.available_sdrs)}</dd></div><div><dt>Números</dt><dd>{fmt(tenant.connected_numbers)}</dd></div><div><dt>Chamadas</dt><dd>{fmt(tenant.active_calls)}</dd></div></dl><div className="panel-actions"><Button variant={tenant.dialer_running ? 'danger' : 'success'} icon={tenant.dialer_running ? 'pause' : 'play'} onClick={() => void toggleDialer(tenant)} disabled={busy === `dialer-${tenant.id}` || tenant.status !== 'active'}>{tenant.dialer_running ? 'Pausar discador' : 'Iniciar discador'}</Button><Button variant="ghost" onClick={() => onOpenTenant?.(tenant.id)}>Abrir operação</Button></div></article>)}</div></Panel>
        <div className="admin-two-columns"><Panel><SectionHeader title="Números WhatsApp" description="Desconectados aparecem primeiro." /><div className="admin-scroll-list">{(operations.numbers ?? []).map((number: AnyRow) => <div className="admin-compact-row" key={number.id}><div><strong>{number.label}</strong><small>{number.tenant_name} · {number.phone || 'sem telefone'}</small></div><Badge tone={statusTone(number.status)}>{statusLabel(number.status)}</Badge>{Boolean(number.flagged) && <Badge tone="warning">Quarentena {Math.ceil(Number(number.quarantine_seconds_remaining ?? 0) / 60)}min</Badge>}{!number.flagged && Number(number.cooldown_seconds_remaining ?? 0) > 0 && <Badge tone="info">Cooldown {number.cooldown_seconds_remaining}s</Badge>}{(Boolean(number.flagged) || Number(number.cooldown_seconds_remaining ?? 0) > 120) && <Button variant="ghost" icon="unlock" onClick={() => void unlockNumber(number.tenant_id, number)} disabled={busy === `number-unlock-${number.id}`}>Destravar</Button>}{!['connected', 'online', 'ready', 'authenticated'].includes(String(number.status)) && <Button variant="ghost" onClick={() => void reconnectNumber(number)} disabled={busy === `number-${number.id}`}>Reconectar</Button>}</div>)}</div></Panel><Panel><SectionHeader title="SDRs" description="Estado atual das equipes." /><div className="admin-scroll-list">{(operations.sdrs ?? []).map((sdr: AnyRow) => <div className="admin-compact-row" key={sdr.id}><div><strong>{sdr.name}</strong><small>{sdr.tenant_name} · última atribuição {dateTime(sdr.last_assigned_at)}</small></div><Badge tone={statusTone(sdr.state)}>{statusLabel(sdr.state)}</Badge>{['in_call', 'post_call'].includes(String(sdr.state)) && <Button variant="ghost" onClick={() => void forceReleaseSdr(sdr.tenant_id, sdr)} disabled={busy === `sdr-force-${sdr.id}`}>Forçar disponível</Button>}</div>)}</div></Panel></div>
        <Panel><SectionHeader title="Chamadas recentes" /><div className="table-scroll"><table className="admin-table"><thead><tr><th>Empresa</th><th>Lead</th><th>SDR</th><th>Número</th><th>Status</th><th>Data</th><th>Ações</th></tr></thead><tbody>{(operations.recentCalls ?? []).map((call: AnyRow) => <tr key={call.id}><td>{call.tenant_name}</td><td>{call.lead_name}</td><td>{call.sdr_name}</td><td>{call.number_label}</td><td><Badge tone={statusTone(call.status)}>{statusLabel(call.status)}</Badge>{['reserved', 'dialing', 'media_active'].includes(String(call.status)) && Number(call.age_seconds ?? 0) > 60 && <small className="text-warning"> · {Math.floor(Number(call.age_seconds) / 60)}min ativa</small>}</td><td>{dateTime(call.created_at)}</td><td>{['reserved', 'dialing', 'media_active'].includes(String(call.status)) && <Button variant="danger" onClick={() => void forceFinishCall(call.tenant_id, call)} disabled={busy === `call-finish-${call.id}`}>Forçar encerramento</Button>}</td></tr>)}</tbody></table></div></Panel>
      </>}

      {section === 'audit' && <Panel><SectionHeader title="Auditoria global" description="Ações administrativas e operacionais registradas pela API." action={<div className="admin-search"><Icon name="search" size={14} /><input aria-label="Buscar auditoria" placeholder="Ação, pessoa ou entidade" value={auditSearch} onChange={(event) => setAuditSearch(event.target.value)} /></div>} /><div className="admin-audit-list">{audit.map((entry) => <article key={entry.id}><div className="admin-audit-icon"><Icon name="history" size={15} /></div><div><strong>{entry.action}</strong><span>{entry.actor_name ?? 'Sistema'} · {entry.tenant_name ?? 'Global'}</span><small>{entry.entity_type ? `${entry.entity_type}${entry.entity_id ? ` · ${entry.entity_id}` : ''}` : 'Ação de plataforma'}</small></div><time>{dateTime(entry.created_at)}</time></article>)}{!audit.length && <EmptyState title="Nenhum evento encontrado" />}</div><Pagination offset={auditOffset} limit={PAGE_SIZE} total={auditPage.total} onChange={setAuditOffset} /></Panel>}

      {section === 'health' && <>
        <div className="admin-health-grid">{Object.entries(health.services ?? {}).map(([key, service]) => { const item = service as AnyRow; const verified = typeof item.ok === 'boolean'; const ok = item.ok === true; const label = verified ? (ok ? 'Operacional' : 'Indisponível') : 'Configurado, não verificado'; return <article key={key}><div className={`admin-health-icon ${ok || !verified ? 'ok' : 'error'}`}><Icon name={ok || !verified ? 'check' : 'alert'} /></div><div><strong>{{ api: 'API', database: 'PostgreSQL', redis: 'Redis', waxum: 'Waxum' }[key] ?? key}</strong><small>{label}{item.error ? ` · ${item.error}` : ''}</small></div><Badge tone={ok ? 'success' : verified ? 'warning' : 'neutral'}>{ok ? 'OK' : verified ? 'Erro' : 'Config.'}</Badge></article>; })}</div>
        <Panel><SectionHeader title="Informações do ambiente" description="Diagnóstico seguro, sem exposição de segredos." /><dl className="admin-environment"><div><dt>Ambiente</dt><dd>{health.environment ?? '—'}</dd></div><div><dt>Uptime</dt><dd>{fmt(health.uptimeSeconds)} segundos</dd></div><div><dt>Resposta</dt><dd>{fmt(health.responseTimeMs)} ms</dd></div><div><dt>Última migration</dt><dd>{health.latestMigration?.version ?? '—'}</dd></div><div><dt>Verificado em</dt><dd>{dateTime(health.checkedAt)}</dd></div></dl></Panel>
      </>}
    </>}
  </div>;
}
