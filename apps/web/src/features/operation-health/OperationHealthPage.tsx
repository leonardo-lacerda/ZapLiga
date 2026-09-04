import { useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { navigateToTab } from '../../app/routes';
import { json } from '../../services/api';

const reasonLabels: Record<string, string> = {
  no_connected_number: 'Nenhuma linha conectada',
  high_failure_rate: 'Taxa de falha elevada',
  rate_limited_numbers: 'Linha(s) sob limite temporário',
  rapid_failure_streak: 'Quedas rápidas em sequência',
  numbers_quarantined: 'Linha(s) em quarentena',
  numbers_in_cooldown: 'Linha(s) em cooldown',
  no_available_sdr: 'Nenhum SDR disponível',
  capacity_exhausted: 'Capacidade ocupada',
  leads_attempt_limit: 'Leads no limite de tentativas',
  callbacks_due: 'Callbacks vencidos',
  suppressed_contacts: 'Contatos suprimidos',
  outside_schedule: 'Fora da agenda permitida',
  policy_block: 'Bloqueio de política',
  insufficient_sample: 'Amostra ainda insuficiente',
  line_protected: 'Linha protegida',
  connected: 'Conectada',
  disconnected: 'Desconectada',
  reconnected: 'Reconectada',
  cooldown_started: 'Cooldown iniciado',
  quarantine_started: 'Quarentena iniciada',
  rate_limited: 'Limite temporário',
  rapid_failure: 'Queda rápida',
};

const stateLabels: Record<string, string> = { healthy: 'Saudável', attention: 'Atenção', degraded: 'Degradado', blocked: 'Bloqueado', insufficient_data: 'Dados insuficientes' };
const stateTone = (state: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' => state === 'healthy' ? 'success' : state === 'blocked' || state === 'degraded' ? 'danger' : state === 'attention' ? 'warning' : 'info';
const reasonLabel = (reason: string) => reasonLabels[reason] ?? reason.replaceAll('_', ' ');
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function HealthStateBadge({ state }: { state: string }) {
  return <Badge tone={stateTone(state)}><i className="badge-dot" />{stateLabels[state] ?? state}</Badge>;
}

function ScoreRing({ score, small = false }: { score: number; small?: boolean }) {
  const bounded = Math.max(0, Math.min(100, Number(score) || 0));
  return <div className={`operation-health-score-ring${small ? ' small' : ''}`} style={{ background: `conic-gradient(var(--health-score-color) ${bounded * 3.6}deg, var(--line-soft) ${bounded * 3.6}deg)` }} aria-label={`Score interno ${bounded} de 100`}><div><strong>{bounded}</strong><small>/100</small></div></div>;
}

function ComponentGrid({ components = [] }: { components?: AnyRow[] }) {
  return <div className="operation-health-component-grid">{components.map((component) => <article className="operation-health-component" key={component.code}><div><strong>{reasonLabel(String(component.code))}</strong><span>{Math.round(Number(component.score) || 0)}/100</span></div><div className="operation-health-progress"><span style={{ width: `${Math.max(0, Math.min(100, Number(component.score) || 0))}%` }} /></div><small>{Number(component.numerator) || 0} de {Number(component.denominator) || 0} · peso {Math.round((Number(component.weight) || 0) * 100)}%</small></article>)}</div>;
}

function OperationHealthPage({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [health, setHealth] = useState<AnyRow | null>(null);
  const [history, setHistory] = useState<AnyRow[]>([]);
  const [numbers, setNumbers] = useState<AnyRow[]>([]);
  const [selectedNumberId, setSelectedNumberId] = useState('');
  const [numberHealth, setNumberHealth] = useState<AnyRow | null>(null);
  const [events, setEvents] = useState<AnyRow[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');

  const load = async () => {
    if (!enabled || !tenantId) return;
    setLoading(true);
    try {
      const [current, previous, numberPage] = await Promise.all([
        json(`/api/tenants/${tenantId}/operation-health`),
        json(`/api/tenants/${tenantId}/operation-health/history?limit=12`),
        json('/api/numbers?limit=100'),
      ]);
      setHealth(current); setHistory(previous.items ?? []); setNumbers(numberPage.items ?? []); setError('');
      setSelectedNumberId((currentId) => currentId || numberPage.items?.[0]?.id || '');
    } catch (value) { setError(value instanceof Error ? value.message : 'Não foi possível carregar a saúde da operação.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000); return () => window.clearInterval(timer); }, [enabled, tenantId]);
  useEffect(() => {
    if (!selectedNumberId || !enabled || !tenantId) { setNumberHealth(null); setEvents([]); return; }
    let cancelled = false;
    void Promise.all([json(`/api/tenants/${tenantId}/numbers/${selectedNumberId}/health`), json(`/api/tenants/${tenantId}/numbers/${selectedNumberId}/health/events?limit=30`)]).then(([current, timeline]) => { if (!cancelled) { setNumberHealth(current); setEvents(timeline.items ?? []); } }).catch((value) => { if (!cancelled) setError(value instanceof Error ? value.message : 'Não foi possível carregar o detalhe da linha.'); });
    return () => { cancelled = true; };
  }, [enabled, tenantId, selectedNumberId]);

  if (!enabled) return <Panel><div className="operation-health-empty"><Icon name="lock" size={22} /><strong>Saúde da operação indisponível</strong><p>O recurso ainda não foi habilitado para esta empresa.</p></div></Panel>;
  if (loading && !health) return <div className="operation-health-page"><div className="operation-health-loading">Calculando os sinais da operação…</div></div>;
  if (error && !health) return <Panel><div className="operation-health-empty"><Icon name="alert" size={22} /><strong>Não foi possível atualizar a saúde</strong><p>{error}</p><Button onClick={() => void load()}>Tentar novamente</Button></div></Panel>;
  if (!health) return null;
  const capacity = health.evidence?.capacity ?? {};
  const queue = health.evidence?.queue ?? {};
  return <div className="operation-health-page">
    <div className="operation-health-page-header"><div><span className="eyebrow">CONFIANÇA OPERACIONAL</span><h1>Saúde da operação</h1><p>Uma leitura auditável da capacidade atual, das proteções e dos próximos riscos.</p></div><div className="operation-health-header-actions"><Button variant="ghost" onClick={() => navigateToTab('dashboard')}>Voltar à visão geral</Button><small>Atualizado {dateTime(health.collectedAt)}</small></div></div>
    {error && <div className="alert operation-health-alert" role="status"><Icon name="alert" size={16} />{error}</div>}
    <section className={`operation-health-hero operation-health-${health.state}`}>
      <ScoreRing score={health.score} />
      <div className="operation-health-hero-copy"><div className="operation-health-hero-title"><span className="eyebrow">SCORE INTERNO DO ZAPLIGA</span><HealthStateBadge state={health.state} /></div><h2>{stateLabels[health.state] ?? health.state}</h2><p>{health.nextSafeAction}</p><small>{health.internalScoreNotice}</small></div>
      <div className="operation-health-hero-facts"><div><span>Chamadas na amostra</span><strong>{health.sampleSize?.attempts ?? 0}</strong></div><div><span>Linhas observadas</span><strong>{health.sampleSize?.numbers ?? 0}</strong></div><div><span>Tendência</span><strong>{health.trend?.direction === 'up' ? 'Subindo' : health.trend?.direction === 'down' ? 'Caindo' : 'Estável'}</strong></div></div>
    </section>
    <div className="operation-health-main-grid"><Panel><SectionHeader eyebrow="POR QUE ESTÁ ASSIM?" title="Componentes do score" description="Cada componente mostra a amostra e o peso usado pela fórmula versionada." /><ComponentGrid components={health.components} /><div className="operation-health-reasons"><strong>Sinais que merecem contexto</strong><div>{(health.reasonCodes ?? []).map((reason: string) => <span key={reason}><Icon name="alert" size={13} />{reasonLabel(reason)}</span>)}</div></div></Panel><Panel><SectionHeader eyebrow="CAPACIDADE AGORA" title="Próxima liberação" description="Proteções internas continuam valendo mesmo quando a operação está sob pressão." /><div className="operation-health-capacity"><div><span>Disponível</span><strong>{capacity.available ?? 0}</strong><small>de {capacity.configured ?? 0} posições configuradas</small></div><div><span>Em uso</span><strong>{capacity.active ?? 0}</strong><small>chamadas ativas</small></div></div><div className="operation-health-release"><Icon name="clock" size={16} /><div><strong>{capacity.nextReleaseAt ? dateTime(capacity.nextReleaseAt) : 'Nenhuma proteção futura registrada'}</strong><small>estimativa da próxima liberação</small></div></div><div className="operation-health-queue"><span>Fila pronta</span><strong>{queue.ready ?? 0}</strong><small>{queue.waiting ?? 0} aguardando · {queue.dueCallbacks ?? 0} callback(s) vencido(s)</small></div></Panel></div>
    <Panel><SectionHeader eyebrow="HISTÓRICO" title="Tendência da saúde" description={`Snapshots persistidos pela API · fórmula ${health.formulaVersion}.`} /><div className="operation-health-history">{history.length ? history.slice().reverse().map((item: AnyRow) => <div className="operation-health-history-row" key={item.id}><time>{dateTime(item.createdAt)}</time><div className="operation-health-history-track"><span style={{ width: `${Math.max(0, Math.min(100, Number(item.score) || 0))}%` }} /></div><strong>{item.score}</strong><HealthStateBadge state={item.state} /></div>) : <div className="operation-health-empty-inline">O histórico começa após a primeira coleta.</div>}</div></Panel>
    <Panel><SectionHeader eyebrow="DRILLDOWN POR LINHA" title="Linhas e proteções" description="Abra uma linha para entender conexão, cooldown, quarentena e eventos recentes." /><div className="operation-health-number-layout"><div className="operation-health-number-list">{numbers.length ? numbers.map((number) => <button type="button" className={`operation-health-number-row ${selectedNumberId === number.id ? 'active' : ''}`} key={number.id} onClick={() => setSelectedNumberId(number.id)}><span className="operation-health-number-icon"><Icon name="phone" size={15} /></span><span><strong>{number.label}</strong><small>{number.status}</small></span><Icon name="chevron-right" size={15} /></button>) : <div className="operation-health-empty-inline">Nenhuma linha cadastrada.</div>}</div>{numberHealth ? <div className="operation-health-number-detail"><div className="operation-health-number-detail-head"><div><span className="eyebrow">LINHA SELECIONADA</span><h3>{numberHealth.label}</h3><small>{numberHealth.status} · atualizado {dateTime(numberHealth.collectedAt)}</small></div><ScoreRing score={numberHealth.score} small /></div><div className="operation-health-number-status"><HealthStateBadge state={numberHealth.state} /><span>{numberHealth.nextSafeAction}</span></div><div className="operation-health-protection-list"><div><span>Cooldown</span><strong>{numberHealth.protection?.cooldown ? 'Ativo' : 'Livre'}</strong></div><div><span>Quarentena</span><strong>{numberHealth.protection?.quarantine ? 'Ativa' : 'Livre'}</strong></div><div><span>Próxima liberação</span><strong>{dateTime(numberHealth.protection?.nextReleaseAt)}</strong></div></div><ComponentGrid components={numberHealth.components} /><div className="operation-health-timeline"><strong>Timeline</strong>{events.length ? events.map((event) => <div className="operation-health-timeline-row" key={event.id}><span className={`operation-health-timeline-dot ${event.actorType === 'human' ? 'human' : 'automatic'}`} /><div><strong>{reasonLabel(String(event.eventType))}</strong><small>{event.actorType === 'human' ? 'Intervenção humana' : 'Automático'} · {dateTime(event.occurredAt)}</small></div></div>) : <div className="operation-health-empty-inline">Nenhum evento recente.</div>}</div></div> : <div className="operation-health-number-placeholder"><Icon name="phone" size={24} /><strong>Selecione uma linha</strong><p>O detalhe e a timeline aparecerão aqui.</p></div>}</div></Panel>
  </div>;
}

export { OperationHealthPage };
