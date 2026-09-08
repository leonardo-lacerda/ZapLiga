import { useEffect, useState, type ReactNode } from 'react';
import type { AnyRow, TabKey } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { formatDateRangeLabel } from '../../components/DateRangePopover';
import { formatNumber } from '../../shared/format';
import { navigateToTab } from '../../app/routes';
import { OnboardingChecklist } from '../onboarding/OnboardingChecklist';
import { OperationsNowPanel } from './OperationsNowPanel';
import { json } from '../../services/api';
import { useSingleFlight } from '../../shared/useSingleFlight';

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

const recommendationTone: Record<string, 'warning' | 'info' | 'neutral'> = { critical: 'warning', warning: 'warning', info: 'info' };
const recommendationIcon: Record<string, string> = { critical: 'alert', warning: 'alert', info: 'sparkles' };

function RecommendationCenter({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [items, setItems] = useState<AnyRow[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!enabled || !tenantId) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setMessage('');
    void json(`/api/tenants/${tenantId}/recommendations?limit=3`)
      .then((result) => {
        if (cancelled) return;
        const nextItems = Array.isArray(result.items) ? result.items : [];
        setItems(nextItems);
        void Promise.all(nextItems.map((item: AnyRow) => json(`/api/tenants/${tenantId}/recommendations/${item.id}/events`, { method: 'POST', body: JSON.stringify({ eventType: 'impression' }) }).catch(() => undefined)));
      })
      .catch(() => { if (!cancelled) setMessage('Não foi possível atualizar as recomendações agora.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, tenantId]);

  const track = async (item: AnyRow, eventType: 'opened' | 'snoozed' | 'dismissed') => {
    try {
      const suffix = eventType === 'snoozed' ? 'snooze' : eventType === 'dismissed' ? 'dismiss' : 'events';
      await json(`/api/tenants/${tenantId}/recommendations/${item.id}/${suffix}`, { method: 'POST', body: eventType === 'opened' ? JSON.stringify({ eventType }) : undefined });
      if (eventType !== 'opened') setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      if (eventType === 'opened' && item.recommendedAction?.payload?.tab) navigateToTab(item.recommendedAction.payload.tab as TabKey);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'A ação não pôde ser registrada.'); }
  };

  const apply = async (item: AnyRow) => {
    if (!window.confirm(`Aplicar a ação "${item.recommendedAction?.label ?? 'recomendada'}"? O estado será revalidado antes da execução.`)) return;
    try {
      await json(`/api/tenants/${tenantId}/recommendations/${item.id}/apply`, { method: 'POST' });
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'A ação não pôde ser aplicada.'); }
  };

  if (!enabled) return null;
  return <section className="recommendation-center" aria-label="Central de recomendações">
    <div className="overview-section-heading"><div><span className="eyebrow">CENTRAL DE COMANDO</span><h2>{items.length ? 'O que merece atenção agora' : 'Operação em ordem'}</h2></div><span className="overview-section-caption">{loading ? 'Atualizando evidências…' : items.length ? `${items.length} recomendação${items.length > 1 ? 'ões' : ''}` : 'Nenhuma prioridade pendente'}</span></div>
    {message && <div className="recommendation-message" role="status">{message}</div>}
    {loading ? <div className="recommendation-loading">Consultando evidências da operação…</div> : items.length ? <div className="recommendation-grid">{items.map((item) => <article className={`recommendation-card recommendation-${recommendationTone[item.severity] ?? 'info'}`} key={item.id}><span className="recommendation-icon"><Icon name={recommendationIcon[item.severity] ?? 'sparkles'} size={16} /></span><div className="recommendation-card-body"><div className="recommendation-card-top"><strong>{item.title}</strong><Badge tone={item.severity === 'critical' ? 'danger' : item.severity === 'warning' ? 'warning' : 'info'}>{item.severity === 'critical' ? 'Crítico' : item.severity === 'warning' ? 'Atenção' : 'Informativo'}</Badge></div><p className="recommendation-evidence">{item.evidence?.summary ?? 'Evidência indisponível.'}</p><small>Atualizado {item.evidence?.observedAt ? new Date(item.evidence.observedAt).toLocaleTimeString('pt-BR') : 'agora'} · Regra v{item.ruleVersion ?? 1}</small><div className="recommendation-actions"><Button variant={item.recommendedAction?.type === 'navigate' ? 'secondary' : 'success'} onClick={() => item.recommendedAction?.type === 'navigate' ? void track(item, 'opened') : void apply(item)}>{item.recommendedAction?.label ?? 'Ver detalhes'}</Button>{item.recommendedAction?.type !== 'navigate' && <Button variant="ghost" onClick={() => void track(item, 'opened')}>Ver detalhes</Button>}<Button variant="ghost" onClick={() => void track(item, 'snoozed')}>Lembrar depois</Button><Button variant="ghost" onClick={() => void track(item, 'dismissed')}>Dispensar</Button></div></div></article>)}</div> : <div className="overview-health-state"><span className="overview-health-icon"><Icon name="check" size={17} /></span><div><strong>Nenhuma recomendação ativa</strong><p>As prioridades são recalculadas com evidências atuais e desaparecem quando a condição é resolvida.</p></div></div>}
  </section>;
}

const operationHealthLabels: Record<string, string> = { healthy: 'Saudável', attention: 'Atenção', degraded: 'Degradado', blocked: 'Bloqueado', insufficient_data: 'Dados insuficientes' };
const operationHealthTone = (state: string) => state === 'healthy' ? 'success' : state === 'blocked' || state === 'degraded' ? 'danger' : state === 'attention' ? 'warning' : 'info';
const operationHealthReason = (reason: string) => ({ no_connected_number: 'nenhuma linha conectada', high_failure_rate: 'falhas acima do esperado', rate_limited_numbers: 'linha sob limite temporário', rapid_failure_streak: 'quedas rápidas em sequência', no_available_sdr: 'nenhum SDR disponível', numbers_quarantined: 'linha em quarentena', insufficient_sample: 'amostra ainda insuficiente' }[reason] ?? reason.replaceAll('_', ' '));

function OperationHealthCard({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [health, setHealth] = useState<AnyRow | null>(null);
  const [loading, setLoading] = useState(enabled);
  const singleFlight = useSingleFlight();
  useEffect(() => {
    if (!enabled || !tenantId) { setHealth(null); setLoading(false); return; }
    let cancelled = false;
    const refresh = () => singleFlight(`overview-health:${tenantId}`, async () => { try { const result = await json(`/api/tenants/${tenantId}/operation-health`); if (!cancelled) setHealth(result); } catch { /* o dashboard continua funcional se o módulo estiver indisponível */ } finally { if (!cancelled) setLoading(false); } });
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled, singleFlight, tenantId]);
  if (!enabled) return null;
  return <Panel className={`overview-operation-health${health ? ` overview-operation-health-${health.state}` : ''}`}><div className="overview-operation-health-heading"><div><span className="eyebrow">CONFIANÇA OPERACIONAL</span><h2>Saúde da operação</h2><p>O que merece atenção antes de aumentar o ritmo.</p></div>{health && <Badge tone={operationHealthTone(health.state)}><i className="badge-dot" />{operationHealthLabels[health.state] ?? health.state}</Badge>}</div>{loading && !health ? <div className="overview-operation-health-loading">Calculando sinais atuais…</div> : health ? <div className="overview-operation-health-body"><div className="overview-operation-health-score"><strong>{health.score}</strong><small>/100 · score interno</small></div><div className="overview-operation-health-copy"><strong>{health.nextSafeAction}</strong><span>{(health.reasonCodes ?? []).slice(0, 2).map((reason: string) => operationHealthReason(reason)).join(' · ') || 'Nenhum risco prioritário identificado.'}</span><small>Atualizado {health.collectedAt ? new Date(health.collectedAt).toLocaleTimeString('pt-BR') : 'agora'} · fórmula {health.formulaVersion}</small></div><Button variant="secondary" onClick={() => navigateToTab('operationHealth')}>Ver diagnóstico</Button></div> : <div className="overview-operation-health-empty"><Icon name="activity" size={18} /><span>Saúde temporariamente indisponível.</span><Button variant="ghost" onClick={() => navigateToTab('operationHealth')}>Abrir página</Button></div>}</Panel>;
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
    <OperationHealthCard tenantId={String(props.tenantId ?? '')} enabled={Boolean(props.featureFlags?.operation_health)} />
    {props.featureFlags?.recommendations ? <RecommendationCenter tenantId={String(props.tenantId ?? '')} enabled /> : <AttentionSection status={status} connectedNumbers={connectedNumbers} sdrs={props.sdrs} toggleDialer={toggleDialer} />}
    <OnboardingChecklist enabled={Boolean(props.featureFlags?.onboarding)} />
    <OperationsNowPanel tenantId={String(props.tenantId ?? '')} fallbackStatus={status} />
    <div className="overview-lower-grid">
      <PerformancePanel status={status} dateRange={dateRange} />
      <RecentActivity logs={logs} />
    </div>
  </div>;
}
