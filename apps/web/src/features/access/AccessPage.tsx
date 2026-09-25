import { useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, Pagination, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import { PAGE_SIZE } from '../../shared/format';
import type { AnyRow } from '../../types';

export function AccessPage({ tenantId, role }: { tenantId: string; role: string }) {
  const [members, setMembers] = useState<AnyRow[]>([]);
  const [membersTotal, setMembersTotal] = useState(0);
  const [membersOffset, setMembersOffset] = useState(0);
  const [invitations, setInvitations] = useState<AnyRow[]>([]);
  const [invitationsTotal, setInvitationsTotal] = useState(0);
  const [invitationsOffset, setInvitationsOffset] = useState(0);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'sdr' | 'leader'>('sdr');
  const [message, setMessage] = useState('');
  const [currentUser, setCurrentUser] = useState({ id: '', email: '' });
  const canInviteLeaders = role === 'super_admin' || role === 'leader';

  const load = async () => {
    if (!tenantId) return;
    try {
      const [nextMembers, nextInvitations, me] = await Promise.all([
        json(`/api/tenants/${tenantId}/members?limit=${PAGE_SIZE}&offset=${membersOffset}`),
        json(`/api/tenants/${tenantId}/invitations?limit=${PAGE_SIZE}&offset=${invitationsOffset}`),
        json('/api/auth/me'),
      ]);
      setMembers(nextMembers.items); setMembersTotal(nextMembers.total); setInvitations(nextInvitations.items); setInvitationsTotal(nextInvitations.total); setCurrentUser({ id: me.user.id, email: me.user.email }); setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => { void load(); }, [tenantId, membersOffset, invitationsOffset]);
  useEffect(() => { setMembersOffset(0); setInvitationsOffset(0); }, [tenantId]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role: inviteRole }) });
      setEmail(''); setMessage(`Convite criado: ${result.invitationUrl}`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const changeStatus = async (userId: string, status: 'active' | 'blocked') => {
    const confirmationEmail = userId === currentUser.id && status !== 'active' ? window.prompt('Para remover seu próprio acesso, digite seu e-mail completo:') : undefined;
    if (userId === currentUser.id && status !== 'active' && confirmationEmail !== currentUser.email) { setMessage('Confirmação cancelada ou e-mail divergente.'); return; }
    try { await json(`/api/tenants/${tenantId}/members/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ status, confirmationEmail }) }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const changeRole = async (member: AnyRow, nextRole: 'leader' | 'sdr') => {
    if (member.role === nextRole) return;
    const confirmationEmail = member.user_id === currentUser.id && member.role === 'leader' ? window.prompt('Para rebaixar seu próprio acesso, digite seu e-mail completo:') : undefined;
    if (member.user_id === currentUser.id && member.role === 'leader' && confirmationEmail !== currentUser.email) { setMessage('Confirmação cancelada ou e-mail divergente.'); return; }
    try { await json(`/api/tenants/${tenantId}/members/${member.user_id}/role`, { method: 'PATCH', body: JSON.stringify({ role: nextRole, confirmationEmail }) }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const revoke = async (invitationId: string, email: string) => {
    if (!window.confirm(`Excluir o convite de ${email}? O link deixará de funcionar.`)) return;
    try { await json(`/api/tenants/${tenantId}/invitations/${invitationId}`, { method: 'DELETE' }); setMessage('Convite excluído.'); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const resend = async (invitationId: string) => {
    try { const result = await json(`/api/tenants/${tenantId}/invitations/${invitationId}/resend`, { method: 'POST' }); setMessage(`Convite reenviado. Link de contingência: ${result.invitationUrl}`); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  return <>
    <div className="page-heading"><div><span className="eyebrow">ACESSO</span><h1>Equipe e convites</h1><p>Controle quem pode operar esta empresa e com qual papel.</p></div><Badge tone="info">{membersTotal} membros</Badge></div>
    {message && <div className="alert" role="alert"><span>{message}</span></div>}
    {canInviteLeaders && <Panel><SectionHeader title="Convidar usuário" description="O convite expira e o usuário criará a própria senha ao aceitar." /><form className="form-row" onSubmit={invite}><input type="email" placeholder="email@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'sdr' | 'leader')}><option value="sdr">SDR</option><option value="leader">Líder</option></select><Button icon="plus">Enviar convite</Button></form></Panel>}
    <Panel><SectionHeader title="Membros ativos" description="Líderes podem administrar líderes e SDRs; o último líder ativo fica protegido." /><div className="access-list">{members.map((member) => <div className="access-row" key={member.user_id}><div><strong>{member.name}</strong><small>{member.email}</small></div>{canInviteLeaders ? <select aria-label={`Papel de ${member.name}`} value={member.role} onChange={(event) => void changeRole(member, event.target.value as 'leader' | 'sdr')}><option value="leader">Líder</option><option value="sdr">SDR</option></select> : <Badge tone={member.role === 'leader' ? 'purple' : 'info'}>{member.role === 'leader' ? 'Líder' : 'SDR'}</Badge>}<Badge tone={member.status === 'active' && member.user_status === 'active' ? 'success' : 'warning'}>{member.status === 'active' && member.user_status === 'active' ? 'Ativo' : 'Bloqueado'}</Badge>{(canInviteLeaders || member.role === 'sdr') && <Button variant="ghost" onClick={() => void changeStatus(member.user_id, member.status === 'active' ? 'blocked' : 'active')}>{member.status === 'active' ? 'Bloquear' : 'Ativar'}</Button>}</div>)}{!members.length && <p className="text-muted">Nenhum membro cadastrado.</p>}</div><Pagination offset={membersOffset} limit={PAGE_SIZE} total={membersTotal} onChange={setMembersOffset} /></Panel>
    <Panel><SectionHeader title="Convites recentes" description="Acompanhe entrega e abertura; o link de contingência aparece ao criar ou reenviar." /><div className="access-list">{invitations.map((invitation) => <div className="access-row" key={invitation.id}><div><strong>{invitation.invited_email}</strong><small>{invitation.role} · expira em {new Date(invitation.expires_at).toLocaleString('pt-BR')}</small></div><Badge tone={invitation.display_status === 'accepted' ? 'success' : ['failed', 'expired', 'revoked'].includes(invitation.display_status) ? 'warning' : 'info'}>{({ sent: 'Enviado', failed: 'Falhou', opened: 'Aberto', accepted: 'Aceito', expired: 'Expirado', revoked: 'Revogado', queued: 'Na fila' } as Record<string, string>)[invitation.display_status] ?? 'Pendente'}</Badge>{!invitation.accepted_at && !invitation.revoked_at && <><Button variant="ghost" onClick={() => void resend(invitation.id)}>Reenviar</Button><Button variant="danger" icon="trash" onClick={() => void revoke(invitation.id, invitation.invited_email)}>Excluir</Button></>}</div>)}{!invitations.length && <p className="text-muted">Nenhum convite enviado.</p>}</div><Pagination offset={invitationsOffset} limit={PAGE_SIZE} total={invitationsTotal} onChange={setInvitationsOffset} /></Panel>
  </>;
}
