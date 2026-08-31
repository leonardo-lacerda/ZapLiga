import type { ReactNode } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { LiveTimer } from '../../components/LiveTimer';
import { formatDateRangeLabel } from '../../components/DateRangePopover';
import { formatDurationCompact, formatNextAttempt, formatSeconds, labelStatus } from '../../shared/format';
import { PostCallPanel } from '../calls/PostCallPanel';
import { OnboardingChecklist } from '../onboarding/OnboardingChecklist';

type SdrPresence = 'offline' | 'connecting' | 'connected' | 'available' | 'dialing' | 'in-call' | 'post-call';

const presenceCopy: Record<SdrPresence, { label: string; description: string; tone: 'neutral' | 'info' | 'success' | 'warning' }> = {
  offline: { label: 'Desconectado', description: 'Conecte seu painel para começar a receber chamadas.', tone: 'neutral' },
  connecting: { label: 'Conectando', description: 'Estabelecendo o canal seguro com a operação…', tone: 'info' },
  connected: { label: 'Conectado · indisponível', description: 'Você pode fazer discagens manuais, mas ainda não receberá chamadas automáticas.', tone: 'neutral' },
  available: { label: 'Disponível', description: 'Aguardando uma chamada da fila.', tone: 'success' },
  dialing: { label: 'Chamando', description: 'A chamada está tocando para o lead.', tone: 'info' },
  'in-call': { label: 'Em atendimento', description: 'O lead atendeu. Fale com ele pelo seu headset.', tone: 'success' },
  'post-call': { label: 'Pós-atendimento', description: 'Registre o resultado da chamada para continuar.', tone: 'warning' },
};

function getSdrPresence({ connecting, connected, sdrReady, available, activeCall, postCall, manualCalling }: AnyRow): SdrPresence {
  if (postCall) return 'post-call';
  if (activeCall) return activeCall.phase === 'answered' || activeCall.mediaActive ? 'in-call' : 'dialing';
  if (manualCalling) return 'dialing';
  if (connecting || (connected && !sdrReady)) return 'connecting';
  if (available) return 'available';
  if (connected && sdrReady) return 'connected';
  return 'offline';
}

export function Dashboard(props: AnyRow) {
  const { isSdr, status, available, connected, connecting, sdrReady, sdrs, connectSdr, setAvailability, manualDial, manualPhone, setManualPhone, manualName, setManualName, manualCalling, logs, activeCall, postCall, hangup, micMuted, toggleMicMute, connectedNumbers, dateRange } = props;
  const rangeLabel = dateRange ? formatDateRangeLabel(dateRange) : 'período selecionado';
  const presence = getSdrPresence({ connecting, connected, sdrReady, available, activeCall, postCall, manualCalling });
  const presenceInfo = presenceCopy[presence];
  const presenceStep = ['offline', 'connecting'].includes(presence) ? 1 : presence === 'connected' ? 2 : ['available', 'dialing'].includes(presence) ? 3 : 4;
  const requiredDialerSettings = ['global_max_concurrent_calls', 'max_attempts_per_lead', 'retry_delay_minutes', 'ring_timeout_seconds', 'default_number_cooldown_seconds'];
  const settingsLoaded = Boolean(status.settings && Object.keys(status.settings).length);
  const configurationIncomplete = !isSdr && settingsLoaded && (!status.schedule?.timezone || requiredDialerSettings.some((key) => !Number.isFinite(Number(status.settings[key]))));
  if (isSdr) return <SdrWorkspace {...props} presence={presence} presenceInfo={presenceInfo} presenceStep={presenceStep} />;
  return <>
    <OnboardingChecklist />
    {configurationIncomplete && <div className="alert app-alert" role="alert"><Icon name="alert" size={17} /><span>A configuração do discador está incompleta. Revise a agenda, o fuso e os limites antes de iniciar novas chamadas.</span></div>}
    <div className="page-heading">
      <div><span className="eyebrow">OPERAÇÃO</span><h1>Visão geral</h1><p>Acompanhe a saúde do discador e mantenha sua equipe em movimento.</p></div>
      <Badge tone={status.running ? 'success' : 'neutral'}><i className="badge-dot"></i>{status.running ? 'Discador operando' : 'Discador pausado'}</Badge>
    </div>
    <div className="metric-grid">
      <MetricCard label="Chamadas no período" value={status.call_counts?.completed ?? 0} icon="phone" tone="blue" detail="Chamadas concluídas" />
      <MetricCard label="Atendidas" value={status.answered ?? 0} icon="check" tone="green" detail={rangeLabel} />
      <MetricCard label="Taxa de atendimento" value={`${status.answer_rate ?? 0}%`} icon="chart" tone="purple" detail="Atendidas sobre o total de chamadas" />
      <MetricCard label="Leads na fila" value={status.lead_counts?.queued ?? 0} icon="users" tone="orange" detail="Contatos aguardando" />
    </div>
    <div className="dashboard-grid">
      <Panel>
        <SectionHeader eyebrow="FILA DE ESPERA" title="Próximos contatos" action={<Badge>{status.queue?.total ?? 0} no total</Badge>} />
        <div className="queue-summary"><div><strong>{status.queue?.ready ?? 0}</strong><span>prontos agora</span></div><div><strong>{status.queue?.waiting ?? 0}</strong><span>aguardando horário</span></div></div>
        <div className="insight-box"><span className="insight-icon"><Icon name="sparkles" size={15} /></span><div><span className="eyebrow">PRÓXIMA AÇÃO</span><strong>{status.next_action ?? 'Carregando...'}</strong>{status.next_lead && <small>{status.next_lead.name} · tentativa {Number(status.next_lead.attempts) + 1} · {formatNextAttempt(status.next_lead.next_eligible_at)}</small>}{status.schedule && status.schedule.allowed === false && status.schedule.next_open_at && <small>Próxima abertura: {new Date(status.schedule.next_open_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} ({status.schedule.timezone})</small>}</div></div>
        <div className="queue-list">{(status.queue?.preview ?? []).map((lead: AnyRow) => <div className="queue-row" key={lead.id}><span className="queue-position">#{lead.queue_position}</span><div><strong>{lead.name}</strong><small>{lead.phone}</small></div><span className={lead.next_eligible_at && new Date(lead.next_eligible_at).getTime() <= Date.now() ? 'text-success' : 'text-muted'}>{labelStatus(lead.status)} · {formatNextAttempt(lead.next_eligible_at)}</span></div>)}{!(status.queue?.preview ?? []).length && <EmptyState title="Nenhum contato na fila" description="Contatos elegíveis aparecerão aqui." />}</div>
      </Panel>
      {isSdr ? <Panel>
        <SectionHeader eyebrow="STATUS DA LINHA" title="Conexão do WhatsApp" action={<Badge tone={status.line_ready ? 'success' : 'neutral'}><i className="badge-dot"></i>{status.line_ready ? 'Conectada' : 'Offline'}</Badge>} />
        <div className={`line-status${status.line_ready ? ' is-online' : ''}`}><span className="line-status-icon"><Icon name={status.line_ready ? 'phone' : 'alert'} size={18} /></span><div><strong>{status.line_ready ? 'Linha pronta para chamadas' : 'Nenhuma linha disponível'}</strong><small>{status.line_ready ? 'O sistema está conectado e pode discar.' : 'Aguardando uma linha ser conectada pela administração.'}</small></div></div>
      </Panel> : <Panel>
        <SectionHeader eyebrow="NÚMEROS CONECTADOS" title="Saúde da operação" action={<Badge tone="success">{connectedNumbers} conectados</Badge>} />
        <div className="number-status-list">{(status.numbers ?? []).map((number: AnyRow) => <div className="number-status" key={number.id}><div className="number-info"><span className="number-icon"><Icon name="phone" size={14} /></span><div><strong>{number.label}</strong><small>{labelStatus(number.status)} · {number.active_calls}/{number.max_concurrent_calls} chamadas</small></div></div>{number.flagged ? <span className="text-warning">⏸ Pausada · limite WhatsApp (~{Math.max(1, Math.ceil(Number(number.flagged_remaining_seconds) / 3600))}h)</span> : <span className={Number(number.cooldown_remaining_seconds) > 0 ? 'text-warning' : 'text-success'}>{Number(number.cooldown_remaining_seconds) > 0 ? `Cooldown: ${formatSeconds(number.cooldown_remaining_seconds)}` : 'Cooldown: livre'}</span>}</div>)}{!(status.numbers ?? []).length && <EmptyState title="Nenhum número cadastrado" description="Adicione um número para iniciar a operação." />}</div>
        <div className="active-call-list"><span className="eyebrow">CHAMADAS AGORA</span>{(status.active_calls_detail ?? []).map((call: AnyRow) => <div className="active-call-row" key={call.id}><strong>{call.lead_name}</strong><span>{call.number_label} · {labelStatus(call.status)} · <LiveTimer startedAt={call.connected_at ?? call.started_at ?? call.created_at} initialSeconds={call.elapsed_seconds} /></span></div>)}{!(status.active_calls_detail ?? []).length && <small className="text-muted">Nenhuma chamada em andamento.</small>}</div>
      </Panel>}
    </div>
    {isSdr && <Panel>
      <SectionHeader eyebrow="SEU PAINEL" title="Operar como SDR" description="Seu acesso está vinculado ao seu usuário. Você não pode selecionar outro SDR." action={<Badge tone={connected ? 'success' : 'neutral'}>{connected ? (sdrReady ? 'Conectado' : 'Identificando...') : 'Offline'}</Badge>} />
      <div className="form-row"><div className="sdr-identity"><Icon name="headset" size={16} /><strong>{sdrs[0]?.name ?? 'Carregando SDR...'}</strong></div><Button icon="plug" onClick={() => void connectSdr()}>Conectar</Button><Button variant={available ? 'success' : 'secondary'} icon={available ? 'check' : 'headset'} onClick={() => setAvailability(!available)} disabled={!connected || !sdrReady}>{available ? 'Disponível' : sdrReady ? 'Ficar disponível' : 'Aguardando conexão'}</Button></div>
      <div className={`sdr-presence sdr-presence-${presence}`} role="status" aria-live="polite"><div className="sdr-presence-icon"><Icon name={presence === 'offline' ? 'headset' : presence === 'post-call' ? 'check' : 'phone'} size={18} /></div><div className="sdr-presence-copy"><span className="eyebrow">STATUS AGORA</span><strong>{presenceInfo.label}</strong><small>{presence === 'dialing' && activeCall?.lead?.name ? `${presenceInfo.description} ${activeCall.lead.name}.` : presenceInfo.description}</small></div><div className="sdr-presence-progress" aria-label={`Etapa ${presenceStep} de 4`}><span className={presenceStep >= 1 ? 'active' : ''}>Conexão</span><span className={presenceStep >= 2 ? 'active' : ''}>Pronto</span><span className={presenceStep >= 3 ? 'active' : ''}>Chamada</span><span className={presenceStep >= 4 ? 'active' : ''}>Registro</span></div></div>
    </Panel>}
    {isSdr && <Panel>
      <SectionHeader eyebrow="DISCAGEM MANUAL" title="Ligar para um telefone" description="Faça uma chamada fora da fila usando um número informado por você." />
      <form className="form-row" onSubmit={(event) => void manualDial(event)}>
        <input type="tel" placeholder="Telefone com DDD" value={manualPhone} onChange={(event) => setManualPhone(event.target.value)} aria-label="Telefone para discagem manual" required />
        <input placeholder="Nome do contato (opcional)" value={manualName} onChange={(event) => setManualName(event.target.value)} aria-label="Nome do contato" />
        <Button variant="success" icon="phone" disabled={manualCalling || !connected || !sdrReady || Boolean(postCall)}>{manualCalling ? 'Iniciando...' : 'Ligar agora'}</Button>
      </form>
    </Panel>}
    {activeCall?.lead && (() => { const answered = activeCall.phase === 'answered' || activeCall.mediaActive; return <Panel className={`active-call-card${answered ? '' : ' is-ringing'}`}><div><span className="eyebrow">{answered ? 'EM CHAMADA' : 'DISCANDO'}</span><h2>{activeCall.lead.name}</h2><p>{activeCall.lead.phone} · {answered ? <>{activeCall.mediaActive ? 'Áudio conectado' : 'Conectando áudio…'} · <LiveTimer startedAt={activeCall.connectedAt ?? activeCall.connected_at ?? activeCall.callStartedAt} /></> : 'Chamando o cliente…'}</p></div><div className="active-call-actions"><Button variant={micMuted ? 'danger' : 'secondary'} icon={micMuted ? 'mic-off' : 'mic'} onClick={toggleMicMute} aria-pressed={Boolean(micMuted)}>{micMuted ? 'Ativar microfone' : 'Mutar microfone'}</Button><Button variant="danger" icon="close" onClick={hangup}>{answered ? 'Encerrar' : 'Desligar'}</Button></div></Panel>; })()}
    <Panel><SectionHeader eyebrow="TEMPO REAL" title="Log do discador" action={<Badge>{logs.length} eventos</Badge>} /><div className="logs">{logs.slice(0, 40).map((entry: AnyRow) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.at).toLocaleTimeString()}</time><span>{entry.message}</span>{entry.callId && <code>{entry.callId.slice(0, 8)}</code>}</div>)}{!logs.length && <EmptyState title="Nenhum evento ainda" description="Os eventos de operação aparecerão aqui em tempo real." />}</div></Panel>
  </>;
}

function SdrWorkspace({ status, available, connected, connecting, sdrReady, sdrs, connectSdr, disconnectSdr, setAvailability, manualDial, manualPhone, setManualPhone, manualName, setManualName, manualCalling, activeCall, postCall, finishPostCall, finishingPause, hangup, micMuted, toggleMicMute, audioReady, connectionNotice, presence, presenceInfo, presenceStep }: AnyRow) {
  const answered = activeCall && (activeCall.phase === 'answered' || activeCall.mediaActive);
  const personal = status.personal ?? {};
  return <div className="sdr-workspace">
    <div className="page-heading sdr-page-heading">
      <div><span className="eyebrow">MINHA ESTAÇÃO</span><h1>Olá, {sdrs[0]?.name?.split(' ')[0] ?? 'SDR'}</h1><p>Conecte o áudio, fique disponível e concentre-se na próxima conversa.</p></div>
      <Badge tone={available ? 'success' : connected ? 'info' : 'neutral'}><i className="badge-dot"></i>{presenceInfo.label}</Badge>
    </div>

    <Panel className={`sdr-command sdr-command-${presence}`}>
      <div className="sdr-command-main"><div className="sdr-presence-icon"><Icon name={presence === 'post-call' ? 'check' : presence === 'offline' ? 'headset' : 'phone'} size={22} /></div><div><span className="eyebrow">STATUS AGORA</span><h2>{presenceInfo.label}</h2><p>{connectionNotice || status.next_action || presenceInfo.description}</p></div></div>
      <div className="sdr-command-health"><Badge tone={status.line_ready ? 'success' : 'warning'}><Icon name="phone" size={13} />{status.line_ready ? 'Linha pronta' : 'Linha indisponível'}</Badge><Badge tone={audioReady ? 'success' : 'neutral'}><Icon name={audioReady ? 'mic' : 'mic-off'} size={13} />{audioReady ? 'Áudio verificado' : 'Áudio não verificado'}</Badge></div>
      <div className="sdr-command-actions">
        {!connected ? <Button icon="plug" disabled={connecting} onClick={() => void connectSdr()}>{connecting ? 'Conectando...' : 'Conectar e testar áudio'}</Button> : <>
          <Button variant={available ? 'success' : 'primary'} icon={available ? 'check' : 'headset'} onClick={() => void setAvailability(!available)} disabled={!sdrReady || Boolean(postCall)}>{available ? 'Disponível · pausar' : 'Ficar disponível'}</Button>
          <Button variant="ghost" onClick={() => void disconnectSdr()}>Desconectar</Button>
        </>}
      </div>
      <div className="sdr-presence-progress" aria-label={`Etapa ${presenceStep} de 4`}><span className={presenceStep >= 1 ? 'active' : ''}>Conexão</span><span className={presenceStep >= 2 ? 'active' : ''}>Pronto</span><span className={presenceStep >= 3 ? 'active' : ''}>Chamada</span><span className={presenceStep >= 4 ? 'active' : ''}>Registro</span></div>
    </Panel>

    {activeCall?.lead && <Panel className={`sdr-call-console${answered ? ' is-active' : ' is-ringing'}`}>
      <div className="sdr-call-person"><span className="sdr-call-icon"><Icon name="phone" size={23} /></span><div><span className="eyebrow">{answered ? 'CONVERSA EM ANDAMENTO' : 'CHAMANDO'}</span><h2>{activeCall.lead.name || 'Contato da fila'}</h2><p>{activeCall.lead.phone} · {answered ? <><LiveTimer startedAt={activeCall.connectedAt ?? activeCall.connected_at ?? activeCall.callStartedAt} /> · {activeCall.mediaActive ? 'áudio conectado' : 'conectando áudio…'}</> : 'aguardando atendimento…'}</p></div></div>
      <div className="sdr-call-actions"><Button variant={micMuted ? 'danger' : 'secondary'} icon={micMuted ? 'mic-off' : 'mic'} onClick={toggleMicMute} aria-pressed={Boolean(micMuted)}>{micMuted ? 'Ativar microfone' : 'Mutar'}</Button><Button variant="danger" icon="close" onClick={hangup}>{answered ? 'Encerrar conversa' : 'Cancelar chamada'}</Button></div>
    </Panel>}

    {postCall && <PostCallPanel pause={postCall} onFinish={finishPostCall} submitting={Boolean(finishingPause)} canContinue={Boolean(connected && sdrReady)} />}

    {!activeCall && !postCall && <div className="sdr-summary-grid">
      <article><span>Conversas · 24h</span><strong>{personal.answered ?? 0}</strong><small>{personal.calls ?? 0} tentativas atribuídas</small></article>
      <article><span>Tempo em conversa</span><strong>{formatDurationCompact(personal.conversation_seconds ?? 0)}</strong><small>últimas 24 horas</small></article>
      <article><span>Fila pronta</span><strong>{status.queue?.ready ?? 0}</strong><small>{status.queue?.waiting ?? 0} aguardando horário</small></article>
    </div>}

    {!activeCall && !postCall && <Panel><SectionHeader eyebrow="PRÓXIMOS RETORNOS" title="Sua agenda" action={<Badge tone={status.overdue_callbacks ? 'warning' : 'info'}>{status.overdue_callbacks ?? 0} atrasados</Badge>} /><div className="queue-list">{(status.callbacks ?? []).map((item: AnyRow) => <div className="queue-row" key={item.id}><span className="queue-position"><Icon name="calendar" size={14} /></span><div><strong>{item.lead_name}</strong><small>{item.lead_phone}</small></div><span className={item.overdue ? 'text-warning' : 'text-muted'}>{new Date(item.due_at).toLocaleString('pt-BR')}</span></div>)}{!(status.callbacks ?? []).length && <EmptyState title="Nenhum retorno agendado" description="Seus próximos retornos aparecerão aqui." />}</div></Panel>}

    {!activeCall && !postCall && <div className="sdr-secondary-grid"><Panel>
      <SectionHeader eyebrow="DISCAGEM MANUAL" title="Ligar para um telefone" description="Use apenas quando precisar ligar fora da fila automática." />
      <form className="form-row" onSubmit={(event) => void manualDial(event)}><input type="tel" placeholder="Telefone com DDD" value={manualPhone} onChange={(event) => setManualPhone(event.target.value)} aria-label="Telefone para discagem manual" required /><input placeholder="Nome do contato (opcional)" value={manualName} onChange={(event) => setManualName(event.target.value)} aria-label="Nome do contato" /><Button variant="success" icon="phone" disabled={manualCalling || !connected || !sdrReady}>{manualCalling ? 'Iniciando...' : 'Ligar agora'}</Button></form>
    </Panel><Panel className="sdr-readiness"><SectionHeader eyebrow="PRONTIDÃO" title="Antes da próxima conversa" /><ul><li className={status.line_ready ? 'done' : ''}><Icon name={status.line_ready ? 'check' : 'alert'} size={15} />Linha do WhatsApp disponível</li><li className={audioReady ? 'done' : ''}><Icon name={audioReady ? 'check' : 'mic'} size={15} />Microfone permitido e verificado</li><li className={available ? 'done' : ''}><Icon name={available ? 'check' : 'headset'} size={15} />Você está disponível na fila</li></ul></Panel></div>}
  </div>;
}

export function MetricCard({ label, value, icon, tone, detail }: { label: string; value: ReactNode; icon: string; tone: string; detail: string }) {
  return <div className="metric-card"><div className={`metric-icon metric-${tone}`}><Icon name={icon} size={17} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
