import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Badge, Button, Pagination, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import { PAGE_SIZE } from '../../shared/format';
import type { AnyRow } from '../../types';
import { LiveTimer } from '../../components/LiveTimer';

type SdrsPageProps = { tenantId: string; sdrs: AnyRow[] };
type InvitationLink = { id: string; url: string; name: string; email: string; expiresAt: string };

const isPending = (invitation: AnyRow) => !invitation.accepted_at && !invitation.revoked_at && new Date(invitation.expires_at).getTime() > Date.now();

export function SdrsPage({ tenantId, sdrs }: SdrsPageProps) {
  const [members, setMembers] = useState<AnyRow[]>([]);
  const [membersTotal, setMembersTotal] = useState(0);
  const [membersOffset, setMembersOffset] = useState(0);
  const [invitations, setInvitations] = useState<AnyRow[]>([]);
  const [invitationsTotal, setInvitationsTotal] = useState(0);
  const [invitationsOffset, setInvitationsOffset] = useState(0);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkBusyId, setLinkBusyId] = useState('');
  const [invitationLink, setInvitationLink] = useState<InvitationLink | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        json(`/api/tenants/${tenantId}/members?role=sdr&limit=${PAGE_SIZE}&offset=${membersOffset}`),
        json(`/api/tenants/${tenantId}/invitations?role=sdr&limit=${PAGE_SIZE}&offset=${invitationsOffset}`),
      ]);
      setMembers(nextMembers.items); setMembersTotal(nextMembers.total);
      setInvitations(nextInvitations.items); setInvitationsTotal(nextInvitations.total);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [tenantId, membersOffset, invitationsOffset]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setMembersOffset(0); setInvitationsOffset(0); }, [tenantId]);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/sdrs/invitations`, { method: 'POST', body: JSON.stringify({ name, email }) });
      await load();
      if (!result.invitationUrl) throw new Error('O link de cadastro não foi gerado.');
      setInvitationLink({ id: result.id, url: result.invitationUrl, name: result.name ?? name, email: result.email ?? email, expiresAt: result.expiresAt });
      setCopied(false); setName(''); setEmail('');
      setMessage('Link de cadastro criado. Copie e envie ao SDR.');
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

  const generateNewLink = async (invitationId: string) => {
    setLinkBusyId(invitationId); setMessage('');
    try {
      const result = await json(`/api/tenants/${tenantId}/sdrs/invitations/${invitationId}/resend`, { method: 'POST' });
      await load();
      if (!result.invitationUrl) throw new Error('O novo link de cadastro não foi gerado.');
      setInvitationLink({ id: result.id, url: result.invitationUrl, name: result.name ?? 'SDR', email: result.email ?? '', expiresAt: result.expiresAt });
      setCopied(false); setMessage('Novo link criado. O link anterior deixou de funcionar.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setLinkBusyId(''); }
  };

  const copyInvitationLink = async () => {
    if (!invitationLink) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(invitationLink.url);
      else {
        const textarea = document.createElement('textarea');
        textarea.value = invitationLink.url; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand('copy')) throw new Error('cópia bloqueada');
        } finally { document.body.removeChild(textarea); }
      }
      setCopied(true); setMessage('Link copiado. Agora envie-o ao SDR.');
    } catch { setMessage('Não foi possível copiar automaticamente. Selecione o link e copie manualmente.'); }
  };

  const revoke = async (invitationId: string) => {
    if (!window.confirm('Revogar este convite? O link deixará de funcionar.')) return;
    try {
      await json(`/api/tenants/${tenantId}/invitations/${invitationId}`, { method: 'DELETE' });
      if (invitationLink?.id === invitationId) { setInvitationLink(null); setCopied(false); }
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  const operationalByUser = useMemo(() => new Map(sdrs.filter((sdr) => sdr.user_id).map((sdr) => [sdr.user_id, sdr])), [sdrs]);
  const pendingInvitations = invitations.filter(isPending);

  return <>
    <div className="page-heading"><div><span className="eyebrow">EQUIPE</span><h1>SDRs</h1><p>Cadastre, convide e acompanhe os operadores da sua empresa.</p></div><Badge tone="info">{membersTotal} SDRs</Badge></div>
    {message && <div className="alert" role="alert"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Fechar mensagem">×</button></div>}
    <Panel>
      <SectionHeader title="Cadastrar SDR" description="Informe os dados do operador e gere um link para ele criar a própria senha." />
      <form className="form-row" onSubmit={invite}>
        <input placeholder="Nome completo" value={name} onChange={(event) => setName(event.target.value)} minLength={2} required />
        <input type="email" placeholder="email@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Button icon="plus" disabled={busy}>{busy ? 'Gerando link...' : 'Gerar link de cadastro'}</Button>
      </form>
      <p className="form-hint">O e-mail identifica o SDR, mas nenhuma mensagem será enviada. Compartilhe o link gerado diretamente com ele.</p>
      {invitationLink && <div className="invitation-link-card" role="status" aria-live="polite">
        <div className="invitation-link-heading"><div><strong>Link de cadastro pronto</strong><p>Envie este link ao SDR para ele finalizar o cadastro.</p></div><Badge tone="success">Manual</Badge></div>
        <div className="invitation-link-field"><input value={invitationLink.url} readOnly aria-label="Link de cadastro do SDR" onFocus={(event) => event.currentTarget.select()} /><Button type="button" variant="secondary" icon={copied ? 'check' : 'copy'} onClick={() => void copyInvitationLink()}>{copied ? 'Copiado' : 'Copiar link'}</Button></div>
        <small className="invitation-link-expiry">Válido até {new Date(invitationLink.expiresAt).toLocaleString('pt-BR')}</small>
      </div>}
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
      <Pagination offset={membersOffset} limit={PAGE_SIZE} total={membersTotal} onChange={setMembersOffset} />
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
            {pending ? <><Button variant="ghost" disabled={linkBusyId === invitation.id} onClick={() => void generateNewLink(invitation.id)}>{linkBusyId === invitation.id ? 'Gerando...' : 'Gerar novo link'}</Button><Button variant="ghost" onClick={() => void revoke(invitation.id)}>Revogar</Button></> : <span />}
          </div>;
        })}
        {!invitations.length && <p className="text-muted">Nenhum convite enviado.</p>}
      </div>
      <Pagination offset={invitationsOffset} limit={PAGE_SIZE} total={invitationsTotal} onChange={setInvitationsOffset} />
      {pendingInvitations.length > 0 && <p className="form-hint">{pendingInvitations.length} convite(s) aguardando aceite.</p>}
    </Panel>
  </>;
}
