import { useEffect, useState } from 'react';
import { Badge, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { LiveTimer } from '../../components/LiveTimer';
import { formatNumber, formatSeconds, labelStatus } from '../../shared/format';
import type { AnyRow } from '../../types';
import { useOperationsRealtime } from './useOperationsRealtime';

type OperationsNowPanelProps = { tenantId: string; fallbackStatus?: AnyRow };

const sdrStateInfo: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning'; icon: string }> = {
  offline: { label: 'Offline', tone: 'neutral', icon: 'headset' },
  available: { label: 'Disponível', tone: 'success', icon: 'check' },
  in_call: { label: 'Em chamada', tone: 'info', icon: 'phone' },
  post_call: { label: 'Pós-atendimento', tone: 'warning', icon: 'check' },
};

const numberStatus = (number: AnyRow) => {
  if (number.flagged) return { label: 'Pausado', tone: 'warning' as const };
  if (Number(number.active_calls) > 0) return { label: 'Em chamada', tone: 'info' as const };
  if (Number(number.cooldown_remaining_seconds) > 0) return { label: 'Cooldown', tone: 'warning' as const };
  if (['connected', 'online', 'ready', 'authenticated'].includes(String(number.status).toLowerCase())) return { label: 'Disponível', tone: 'success' as const };
  return { label: labelStatus(number.status), tone: 'neutral' as const };
};

const maskPhone = (value: unknown) => {
  const phone = String(value ?? '').trim();
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 5) return '****';
  let digitIndex = 0;
  return phone.replace(/\d/g, () => {
    digitIndex += 1;
    return digitIndex <= digits.length - 4 ? '*' : digits[digitIndex - 1];
  });
};

const activityCopy = (activity: AnyRow | null) => {
  if (!activity) return null;
  if (activity.kind === 'lead_rescheduled') return { title: 'Nova tentativa agendada', detail: activity.leadName ? `${activity.leadName} · ${activity.callbackAt ? `às ${new Date(activity.callbackAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'voltou para a fila'}` : 'Um lead voltou para a fila' };
  if (activity.kind === 'call_started') return { title: 'Lead atendido', detail: activity.leadName ? `${activity.leadName} · conversa em andamento` : 'Uma conversa começou' };
  if (activity.kind === 'post_call_started') return { title: 'Pós-atendimento iniciado', detail: activity.leadName ? `${activity.leadName} · aguardando registro` : 'Um SDR precisa registrar o resultado' };
  if (activity.kind === 'number_flagged') return { title: 'Número pausado', detail: 'Uma linha foi protegida após atingir o limite do WhatsApp' };
  return null;
};

function LiveCountdown({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, Number(seconds) || 0));
  useEffect(() => {
    setRemaining(Math.max(0, Number(seconds) || 0));
    const timer = window.setInterval(() => setRemaining((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return <span>{formatSeconds(remaining)}</span>;
}

function SdrActivityRow({ sdr }: { sdr: AnyRow }) {
  const activeCall = sdr.active_call_id ? sdr : null;
  const state = String(sdr.state ?? 'offline');
  const stateInfo = sdrStateInfo[state] ?? { label: labelStatus(state), tone: 'neutral' as const, icon: 'headset' };
  const callPhase = activeCall && ['reserved', 'dialing'].includes(String(activeCall.active_call_status)) ? 'Discando' : stateInfo.label;
  const leadName = activeCall?.active_lead_name ?? (state === 'post_call' ? sdr.pause_lead_name : '');
  const leadPhone = activeCall?.active_lead_phone ?? (state === 'post_call' ? sdr.pause_lead_phone : '');
  const timerStartedAt = activeCall?.active_call_connected_at ?? activeCall?.active_call_started_at ?? sdr.pause_started_at;
  const timerInitialSeconds = activeCall ? Number(activeCall.active_call_elapsed_seconds ?? 0) : Number(sdr.pause_elapsed_seconds ?? 0);

  return <article className={`operations-sdr-row operations-sdr-${state}`}>
    <span className="operations-sdr-icon"><Icon name={stateInfo.icon} size={16} /></span>
    <div className="operations-sdr-person">
      <strong>{sdr.name}</strong>
      <small>{leadName ? `${leadName}${leadPhone ? ` · ${maskPhone(leadPhone)}` : ''}` : state === 'available' ? 'Aguardando uma chamada' : 'Sem atividade ativa'}</small>
    </div>
    <Badge tone={stateInfo.tone}><i className="badge-dot"></i>{callPhase}</Badge>
    <div className="operations-sdr-time">{timerStartedAt ? <LiveTimer startedAt={timerStartedAt} initialSeconds={timerInitialSeconds} /> : <span>—</span>}</div>
  </article>;
}

export function OperationsNowPanel({ tenantId, fallbackStatus = {} }: OperationsNowPanelProps) {
  const realtime = useOperationsRealtime(tenantId, Boolean(tenantId));
  const snapshot = realtime.snapshot ?? fallbackStatus;
  const sdrs = (snapshot.sdrs ?? []) as AnyRow[];
  const numbers = (snapshot.numbers ?? []) as AnyRow[];
  const queue = (snapshot.queue?.preview ?? []) as AnyRow[];
  const activity = activityCopy(realtime.activity);
  const connectionLabel = realtime.connection === 'connected' ? 'Tempo real ativo' : realtime.connection === 'fallback' ? 'Atualização automática' : realtime.connection === 'connecting' ? 'Conectando…' : 'Offline';
  const connectionTone = realtime.connection === 'connected' ? 'success' : realtime.connection === 'fallback' ? 'warning' : realtime.connection === 'connecting' ? 'info' : 'neutral';
  const updatedAt = snapshot.generated_at ? new Date(snapshot.generated_at) : null;
  const updatedLabel = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const attemptsToday = Number(snapshot.attempts_today ?? Object.values(snapshot.call_counts ?? {}).reduce((total: number, count: unknown) => total + Number(count ?? 0), 0));
  const attendedToday = Number(snapshot.leads_attended_today ?? snapshot.answered ?? 0);
  const availableSdrs = Number(snapshot.available_sdrs ?? sdrs.filter((sdr) => sdr.state === 'available' && sdr.available).length);
  const activeCalls = Number(snapshot.active_calls ?? (snapshot.active_calls_detail ?? []).length);

  return <div className="operations-now">
    <Panel className="operations-overview-panel">
      <SectionHeader eyebrow="OPERAÇÃO" title="Operação agora" description="Acompanhe a atividade do seu time e das linhas em tempo real." action={<div className="operations-live-meta"><Badge tone={connectionTone}><i className="badge-dot"></i>{connectionLabel}</Badge><small>Atualizado às {updatedLabel}</small></div>} />
      <div className="operations-kpi-grid">
        <article><span>SDRs disponíveis</span><strong>{formatNumber(availableSdrs)}</strong><small>{formatNumber(sdrs.length)} cadastrados</small></article>
        <article><span>Chamadas em andamento</span><strong>{formatNumber(activeCalls)}</strong><small>limite simultâneo · {formatNumber(snapshot.simultaneous_limit ?? snapshot.settings?.global_max_concurrent_calls ?? 0)}</small></article>
        <article><span>Tentativas hoje</span><strong>{formatNumber(attemptsToday)}</strong><small>chamadas iniciadas no dia</small></article>
        <article><span>Leads atendidos</span><strong>{formatNumber(attendedToday)}</strong><small>leads distintos conectados</small></article>
      </div>
    </Panel>

    <div className="operations-columns">
      <Panel className="operations-team-panel">
        <SectionHeader eyebrow="ATIVIDADE DO TIME" title="SDRs agora" action={<Badge>{sdrs.length} SDRs</Badge>} />
        <div className="operations-sdr-list">
          {sdrs.map((sdr) => <SdrActivityRow key={sdr.id} sdr={sdr} />)}
          {!sdrs.length && <EmptyState title="Nenhum SDR cadastrado" description="Os operadores da empresa aparecerão aqui." />}
        </div>
      </Panel>

      <div className="operations-side-panels">
        <Panel>
          <SectionHeader eyebrow="FILA DE LEADS" title="Próximos contatos" action={<Badge>{formatNumber(snapshot.queue?.total ?? queue.length)} no total</Badge>} />
          <div className="operations-queue-list">
            {queue.map((lead) => <div className="operations-queue-row" key={lead.id}><div><strong>{lead.name}</strong><small>{maskPhone(lead.phone)}</small></div><Badge tone={lead.next_eligible_at && new Date(lead.next_eligible_at).getTime() <= Date.now() ? 'info' : 'neutral'}>{lead.next_eligible_at && new Date(lead.next_eligible_at).getTime() <= Date.now() ? 'Pronto agora' : `Retry · ${lead.next_eligible_at ? new Date(lead.next_eligible_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'aguardando'}`}</Badge></div>)}
            {!queue.length && <p className="operations-empty-note">Nenhum lead aguardando discagem.</p>}
          </div>
        </Panel>

        <Panel>
          <SectionHeader eyebrow="POOL DE NÚMEROS" title="Linhas da operação" action={<Badge tone="success">{numbers.filter((number) => numberStatus(number).tone === 'success').length} disponíveis</Badge>} />
          <div className="operations-number-list">
            {numbers.map((number) => { const info = numberStatus(number); return <div className="operations-number-row" key={number.id}><div className="operations-number-label"><span className="number-icon"><Icon name="phone" size={14} /></span><div><strong>{number.label}</strong><small>{Number(number.active_calls ?? 0)} / {Number(number.max_concurrent_calls ?? 0)} chamadas</small></div></div><div className="operations-number-status"><Badge tone={info.tone}>{info.label}</Badge>{Number(number.cooldown_remaining_seconds) > 0 && <small><LiveCountdown seconds={Number(number.cooldown_remaining_seconds)} /></small>}</div></div>; })}
            {!numbers.length && <p className="operations-empty-note">Nenhum número cadastrado.</p>}
          </div>
        </Panel>
      </div>
    </div>

    {activity && <div className="operations-toast" role="status" aria-live="polite"><span className="operations-toast-icon"><Icon name="phone" size={16} /></span><div><strong>{activity.title}</strong><small>{activity.detail}</small></div></div>}
    {realtime.error && realtime.connection !== 'connected' && <div className="operations-inline-warning" role="status"><Icon name="alert" size={14} />{realtime.error}</div>}
  </div>;
}
