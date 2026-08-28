import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import { LiveTimer } from '../../components/LiveTimer';

type SdrsPageProps = { tenantId: string; sdrs: AnyRow[] };

const isPending = (invitation: AnyRow) => !invitation.accepted_at && !invitation.revoked_at && new Date(invitation.expires_at).getTime() > Date.now();

export function SdrsPage({ tenantId, sdrs }: SdrsPageProps) {
  const [members, setMembers] = useState<AnyRow[]>([]);
  const [invitations, setInvitations] = useState<AnyRow[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        json(`/api/tenants/${tenantId}/members`),
        json(`/api/tenants/${tenantId}/invitations`),
      ]);
      setMembers(nextMembers.filter((member: AnyRow) => member.role === 'sdr'));
      setInvitations(nextInvitations.filter((invitation: AnyRow) => invitation.role === 'sdr'));
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/sdrs/invitations`, { method: 'POST', body: JSON.stringify({ name, email }) });
      setName(''); setEmail('');
      setMessage(result.invitationUrl ? `Convite criado. Link: ${result.invitationUrl}` : 'Convite criado e enviado por e-mail.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const changeStatus = async (userId: string, status: 'active' | 'blocked') => {
    try {
      await json(`/api/tenants/${tenantId}/members/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const resend = async (invitationId: string) => {
    try {
      const result = await json(`/api/tenants/${tenantId}/sdrs/invitations/${invitationId}/resend`, { method: 'POST' });
      setMessage(result.invitationUrl ? `Convite reenviado. Link: ${result.invitationUrl}` : 'Convite reenviado por e-mail.');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const revoke = async (invitationId: string) => {
    if (!window.confirm('Revogar este convite? O link deixará de funcionar.')) return;
    try {
      await json(`/api/tenants/${tenantId}/invitations/${invitationId}`, { method: 'DELETE' });
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const operationalByUser = useMemo(() => new Map(sdrs.filter((sdr) => sdr.user_id).map((sdr) => [sdr.user_id, sdr])), [sdrs]);
  const pendingInvitations = invitations.filter(isPending);

  return <>
    <div className="page-heading"><div><span className="eyebrow">EQUIPE</span><h1>SDRs</h1><p>Cadastre, convide e acompanhe os operadores da sua empresa.</p></div><Badge tone="info">{members.length} SDRs</Badge></div>
    {message && <div className="alert" role="alert"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}
    <Panel>
      <SectionHeader title="Cadastrar SDR" description="Informe os dados do operador. Ele receberá um convite e criará a própria senha." />
      <form className="form-row" onSubmit={invite}>
        <input placeholder="Nome completo" value={name} onChange={(event) => setName(event.target.value)} minLength={2} required />
        <input type="email" placeholder="email@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Button icon="plus" disabled={busy}>{busy ? 'Enviando...' : 'Enviar convite'}</Button>
      </form>
      <p className="form-hint">O acesso será criado como SDR. O organizador não define a senha e não pode criar Admin ou líder por este formulário.</p>
    </Panel>
    <Panel>
      <SectionHeader title="SDRs cadastrados" description="Status de acesso e situação operacional dos operadores." />
      <div className="access-list">
        {members.map((member) => {
          const operational = operationalByUser.get(member.user_id);
          const active = member.status === 'active' && member.user_status === 'active';
          return <div className="access-row" key={member.user_id}>
            <div><strong>{member.name}</strong><small>{member.email}</small></div>
            <Badge tone={active ? 'success' : 'warning'}>{active ? 'Ativo' : 'Bloqueado'}</Badge>
            {operational && <Badge tone={operational.available ? 'success' : 'neutral'}>{operational.state === 'post_call' ? <><span>Pós-atendimento · </span><LiveTimer startedAt={operational.pause_started_at} /></> : operational.available ? 'Disponível' : 'Offline'}</Badge>}
            <Button variant="ghost" onClick={() => void changeStatus(member.user_id, active ? 'blocked' : 'active')}>{active ? 'Bloquear' : 'Reativar'}</Button>
          </div>;
        })}
        {!members.length && <p className="text-muted">Nenhum SDR aceitou um convite ainda.</p>}
      </div>
    </Panel>
    <Panel>
      <SectionHeader title="Convites de SDR" description="Convites pendentes podem ser reenviados ou revogados." />
      <div className="access-list">
        {invitations.map((invitation) => {
          const pending = isPending(invitation);
          const state = invitation.accepted_at ? 'Aceito' : invitation.revoked_at ? 'Revogado' : 'Expirado';
          return <div className="access-row" key={invitation.id}>
            <div><strong>{invitation.invitee_name || 'SDR'}</strong><small>{invitation.invited_email} · expira em {new Date(invitation.expires_at).toLocaleString('pt-BR')}</small></div>
            <Badge tone={invitation.accepted_at ? 'success' : pending ? 'info' : 'warning'}>{state}</Badge>
            {pending ? <><Button variant="ghost" onClick={() => void resend(invitation.id)}>Reenviar</Button><Button variant="ghost" onClick={() => void revoke(invitation.id)}>Revogar</Button></> : <span />}
          </div>;
        })}
        {!invitations.length && <p className="text-muted">Nenhum convite enviado.</p>}
      </div>
      {pendingInvitations.length > 0 && <p className="form-hint">{pendingInvitations.length} convite(s) aguardando aceite.</p>}
    </Panel>
  </>;
}
