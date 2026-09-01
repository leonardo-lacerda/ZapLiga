import type { ReactNode } from 'react';
import type { AnyRow, TabKey } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { formatDateRangeLabel } from '../../components/DateRangePopover';
import { formatNumber } from '../../shared/format';
import { navigateToTab } from '../../app/routes';
import { OnboardingChecklist } from '../onboarding/OnboardingChecklist';
import { OperationsNowPanel } from './OperationsNowPanel';

const requiredDialerSettings = ['global_max_concurrent_calls', 'max_attempts_per_lead', 'retry_delay_minutes', 'ring_timeout_seconds', 'default_number_cooldown_seconds'];

type AttentionItem = {
  tone: 'warning' | 'info' | 'neutral';
  icon: string;
  title: string;
  description: string;
  action: string;
  tab?: TabKey;
  run?: () => void;
};

function openTab(tab: TabKey) {
  navigateToTab(tab);
}

function OverviewMetric({ label, value, detail, tone }: { label: string; value: ReactNode; detail: string; tone: string }) {
  return <article className={`overview-metric overview-metric-${tone}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </article>;
}

function AttentionCard({ item }: { item: AttentionItem }) {
  const handleAction = () => {
    if (item.run) item.run();
    else if (item.tab) openTab(item.tab);
  };

  return <article className={`overview-attention-card overview-attention-${item.tone}`}>
    <span className="overview-attention-icon"><Icon name={item.icon} size={16} /></span>
    <div>
      <strong>{item.title}</strong>
      <p>{item.description}</p>
    </div>
    <Button variant="ghost" onClick={handleAction}>{item.action}</Button>
  </article>;
}

function OverviewHero({ status, dateRange, toggleDialer }: AnyRow) {
  const running = Boolean(status.running);
  const outsideSchedule = status.schedule?.allowed === false;
  const statusLabel = outsideSchedule ? 'Fora do horário' : running ? 'Discador operando' : 'Discador pausado';
  const statusTone = outsideSchedule ? 'warning' : running ? 'success' : 'neutral';
  const rangeLabel = dateRange ? formatDateRangeLabel(dateRange) : 'período selecionado';

  return <div className="overview-hero">
    <div className="overview-hero-copy">
      <span className="eyebrow">OPERAÇÃO</span>
      <h1>Visão geral</h1>
      <p>Tenha uma leitura rápida da operação e aja sobre o que precisa de atenção.</p>
      <div className="overview-hero-meta">
        <Badge tone={statusTone}><i className="badge-dot"></i>{statusLabel}</Badge>
        <span><Icon name="calendar" size={13} />{rangeLabel}</span>
      </div>
    </div>
    <div className="overview-hero-action">
      <span className="overview-hero-kicker">PRÓXIMA DECISÃO</span>
      <strong>{running ? 'A operação está rodando' : 'A operação está pausada'}</strong>
      <small>{outsideSchedule ? `Retoma dentro da agenda · ${status.schedule?.timezone ?? 'fuso não informado'}` : running ? 'Acompanhe os indicadores enquanto a fila avança.' : 'Inicie o discador quando SDRs, linhas e fila estiverem prontos.'}</small>
      <Button variant={running ? 'danger' : 'primary'} icon={running ? 'pause' : 'play'} onClick={() => typeof toggleDialer === 'function' && void toggleDialer()}>{running ? 'Pausar discador' : 'Iniciar discador'}</Button>
    </div>
  </div>;
}

function AttentionSection({ status, connectedNumbers, toggleDialer, sdrs }: AnyRow) {
  const settingsLoaded = Boolean(status.settings && Object.keys(status.settings).length);
  const configurationIncomplete = settingsLoaded && (!status.schedule?.timezone || requiredDialerSettings.some((key) => !Number.isFinite(Number(status.settings[key]))));
  const totalSdrs = Array.isArray(sdrs) ? sdrs.length : 0;
  const queued = Number(status.queue?.total ?? status.lead_counts?.queued ?? 0);
  const items: AttentionItem[] = [];

  if (configurationIncomplete) items.push({ tone: 'warning', icon: 'settings', title: 'Configuração incompleta', description: 'Revise agenda, fuso e limites antes de iniciar novas chamadas.', action: 'Revisar discador', tab: 'settings' });
  if (!connectedNumbers) items.push({ tone: 'warning', icon: 'phone', title: 'Nenhuma linha disponível', description: 'Conecte um número de WhatsApp para liberar a discagem.', action: 'Conectar número', tab: 'numbers' });
  if (!totalSdrs) items.push({ tone: 'info', icon: 'users', title: 'Convide o primeiro SDR', description: 'Sua equipe aparecerá aqui assim que aceitar um convite.', action: 'Cadastrar SDR', tab: 'sdrs' });
  else if (!Number(status.available_sdrs ?? 0) && status.running) items.push({ tone: 'info', icon: 'headset', title: 'Nenhum SDR disponível', description: 'A fila está pronta, mas não há operador disponível agora.', action: 'Ver equipe', tab: 'sdrs' });
  if (!status.running && connectedNumbers && totalSdrs) items.push({ tone: 'neutral', icon: 'play', title: 'Discador pausado', description: 'A operação só avança quando o discador estiver ativo.', action: 'Iniciar agora', run: () => typeof toggleDialer === 'function' && void toggleDialer() });
  if (status.running && !queued) items.push({ tone: 'neutral', icon: 'users', title: 'Fila sem leads prontos', description: 'Importe ou organize leads para manter o ritmo de chamadas.', action: 'Ver leads', tab: 'leads' });

  const visibleItems = items.slice(0, 3);
  return <section className="overview-attention" aria-label="Atenção necessária">
    <div className="overview-section-heading"><div><span className="eyebrow">ATENÇÃO NECESSÁRIA</span><h2>{visibleItems.length ? 'Resolva os próximos bloqueios' : 'Operação em ordem'}</h2></div><span className="overview-section-caption">{visibleItems.length ? `${visibleItems.length} ponto${visibleItems.length > 1 ? 's' : ''} para acompanhar` : 'Nenhuma ação pendente agora'}</span></div>
    {visibleItems.length ? <div className="overview-attention-grid">{visibleItems.map((item) => <AttentionCard key={item.title} item={item} />)}</div> : <div className="overview-health-state"><span className="overview-health-icon"><Icon name="check" size={17} /></span><div><strong>Todos os sinais principais estão saudáveis</strong><p>Continue acompanhando o painel em tempo real para reagir rapidamente às mudanças.</p></div></div>}
  </section>;
}

function PerformancePanel({ status, dateRange }: AnyRow) {
  const completed = Number(status.call_counts?.completed ?? 0);
  const answered = Number(status.answered ?? 0);
  const rate = Math.max(0, Math.min(100, Number(status.answer_rate ?? 0)));
  const queued = Number(status.lead_counts?.queued ?? status.queue?.total ?? 0);
  const rangeLabel = dateRange ? formatDateRangeLabel(dateRange) : 'período selecionado';

  return <Panel className="overview-performance-panel">
    <SectionHeader eyebrow="DESEMPENHO" title="Resultado da operação" description={`Resumo de ${rangeLabel.toLowerCase()}.`} action={<Button variant="ghost" onClick={() => openTab('metrics')}>Ver métricas</Button>} />
    <div className="overview-performance-grid">
      <OverviewMetric label="Chamadas concluídas" value={formatNumber(completed)} detail="No período" tone="blue" />
      <OverviewMetric label="Leads atendidos" value={formatNumber(answered)} detail="Conversas iniciadas" tone="green" />
      <OverviewMetric label="Leads na fila" value={formatNumber(queued)} detail="Aguardando discagem" tone="orange" />
    </div>
    <div className="overview-rate-block"><div><span>Taxa de atendimento</span><strong>{rate}%</strong></div><div className="overview-rate-track" aria-label={`${rate}% de taxa de atendimento`}><span style={{ width: `${rate}%` }} /></div><small>Atendidas sobre o total de chamadas</small></div>
  </Panel>;
}

function RecentActivity({ logs }: AnyRow) {
  return <Panel className="overview-activity-panel">
    <SectionHeader eyebrow="ATIVIDADE RECENTE" title="Últimos eventos" description="O que aconteceu na operação mais recentemente." action={<Button variant="ghost" onClick={() => openTab('calls')}>Ver histórico</Button>} />
    <div className="overview-activity-list">
      {(logs ?? []).slice(0, 6).map((entry: AnyRow) => <div className={`overview-activity-row ${entry.level ?? 'info'}`} key={entry.id}><span className="overview-activity-dot" /><time>{new Date(entry.at).toLocaleTimeString('pt-BR')}</time><strong>{entry.message}</strong>{entry.callId && <code>{String(entry.callId).slice(0, 8)}</code>}</div>)}
      {!(logs ?? []).length && <div className="overview-activity-empty"><Icon name="history" size={18} /><span>Nenhum evento registrado ainda.</span></div>}
    </div>
  </Panel>;
}

export function OrganizerOverview(props: AnyRow) {
  const { status, dateRange, logs, connectedNumbers, toggleDialer } = props;
  return <div className="organizer-overview">
    <OverviewHero status={status} dateRange={dateRange} toggleDialer={toggleDialer} />
    <AttentionSection status={status} connectedNumbers={connectedNumbers} sdrs={props.sdrs} toggleDialer={toggleDialer} />
    <OnboardingChecklist />
    <OperationsNowPanel tenantId={String(props.tenantId ?? '')} fallbackStatus={status} />
    <div className="overview-lower-grid">
      <PerformancePanel status={status} dateRange={dateRange} />
      <RecentActivity logs={logs} />
    </div>
  </div>;
}
