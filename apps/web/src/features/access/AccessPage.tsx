import { useEffect, useState } from 'react';
import type React from 'react';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

export function AccessPage({ tenantId, role }: { tenantId: string; role: string }) {
  const [members, setMembers] = useState<AnyRow[]>([]);
  const [invitations, setInvitations] = useState<AnyRow[]>([]);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'sdr' | 'leader'>('sdr');
  const [message, setMessage] = useState('');
  const canInviteLeaders = role === 'super_admin';

  const load = async () => {
    if (!tenantId) return;
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        json(`/api/tenants/${tenantId}/members`),
        json(`/api/tenants/${tenantId}/invitations`),
      ]);
      setMembers(nextMembers); setInvitations(nextInvitations); setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => { void load(); }, [tenantId]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role: inviteRole }) });
      setEmail(''); setMessage(`Convite criado: ${result.invitationUrl}`); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const changeStatus = async (userId: string, status: 'active' | 'blocked') => {
    try { await json(`/api/tenants/${tenantId}/members/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  return <>
    <div className="page-heading"><div><span className="eyebrow">ACESSO</span><h1>Equipe e convites</h1><p>Controle quem pode operar esta empresa e com qual papel.</p></div><Badge tone="info">{members.length} membros</Badge></div>
    {message && <div className="alert" role="alert"><span>{message}</span></div>}
    {canInviteLeaders && <Panel><SectionHeader title="Convidar usuário" description="O convite expira e o usuário criará a própria senha ao aceitar." /><form className="form-row" onSubmit={invite}><input type="email" placeholder="email@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required /><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'sdr' | 'leader')}><option value="sdr">SDR</option><option value="leader">Líder</option></select><Button icon="plus">Enviar convite</Button></form></Panel>}
    <Panel><SectionHeader title="Membros ativos" description="O Admin supremo pode administrar líderes; líderes administram apenas SDRs." /><div className="access-list">{members.map((member) => <div className="access-row" key={member.user_id}><div><strong>{member.name}</strong><small>{member.email}</small></div><Badge tone={member.role === 'leader' ? 'purple' : 'info'}>{member.role === 'leader' ? 'Líder' : 'SDR'}</Badge><Badge tone={member.status === 'active' && member.user_status === 'active' ? 'success' : 'warning'}>{member.status === 'active' && member.user_status === 'active' ? 'Ativo' : 'Bloqueado'}</Badge>{(canInviteLeaders || member.role === 'sdr') && <Button variant="ghost" onClick={() => void changeStatus(member.user_id, member.status === 'active' ? 'blocked' : 'active')}>{member.status === 'active' ? 'Bloquear' : 'Ativar'}</Button>}</div>)}{!members.length && <p className="text-muted">Nenhum membro cadastrado.</p>}</div></Panel>
    <Panel><SectionHeader title="Convites recentes" description="Links são exibidos apenas no momento da criação para facilitar o envio manual em ambiente local." /><div className="access-list">{invitations.map((invitation) => <div className="access-row" key={invitation.id}><div><strong>{invitation.invited_email}</strong><small>{invitation.role} · expira em {new Date(invitation.expires_at).toLocaleString('pt-BR')}</small></div><Badge tone={invitation.accepted_at ? 'success' : invitation.revoked_at ? 'warning' : 'info'}>{invitation.accepted_at ? 'Aceito' : invitation.revoked_at ? 'Revogado' : 'Pendente'}</Badge></div>)}{!invitations.length && <p className="text-muted">Nenhum convite enviado.</p>}</div></Panel>
  </>;
}
