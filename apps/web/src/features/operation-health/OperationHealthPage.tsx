import { useEffect, useState, type CSSProperties } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FactGrid, FeatureOff, HowItWorks, LoadingBlock, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { navigateToTab } from '../../app/routes';
import { json } from '../../services/api';

// Everything the API says in codes is said here in the operator's words.
const componentCopy: Record<string, { label: string; meaning: string; unit: string }> = {
  connectivity: { label: 'Linhas conectadas', meaning: 'Quantas das suas linhas de WhatsApp estão online agora.', unit: 'linhas' },
  stability: { label: 'Chamadas sem falha', meaning: 'Das últimas tentativas, quantas não caíram nem falharam.', unit: 'chamadas' },
  capacity: { label: 'Capacidade livre', meaning: 'Posições de chamada simultânea que ainda estão disponíveis.', unit: 'posições' },
  team: { label: 'SDRs disponíveis', meaning: 'Quem está conectado e pronto para atender neste momento.', unit: 'SDRs' },
  queue: { label: 'Fila pronta', meaning: 'Leads que podem ser discados agora, dentro da fila total.', unit: 'leads' },
  compliance: { label: 'Agenda e políticas', meaning: 'Se estamos dentro do horário permitido e sem bloqueios de política.', unit: '' },
};
const reasonLabels: Record<string, string> = {
  no_connected_number: 'Nenhuma linha conectada', high_failure_rate: 'Muitas chamadas falhando', rate_limited_numbers: 'Linha com limite temporário do WhatsApp', rapid_failure_streak: 'Chamadas caindo em sequência', numbers_quarantined: 'Linha em quarentena', numbers_in_cooldown: 'Linha em pausa protetora', no_available_sdr: 'Nenhum SDR disponível', capacity_exhausted: 'Todas as posições ocupadas', leads_attempt_limit: 'Leads que esgotaram as tentativas', callbacks_due: 'Retornos agendados vencidos', suppressed_contacts: 'Contatos na lista de não-contato', outside_schedule: 'Fora do horário permitido', policy_block: 'Bloqueio de política', insufficient_sample: 'Poucas chamadas para avaliar', line_protected: 'Linha protegida',
  connected: 'Conectou', disconnected: 'Desconectou', reconnected: 'Reconectou', cooldown_started: 'Entrou em pausa protetora', quarantine_started: 'Entrou em quarentena', rate_limited: 'Recebeu limite temporário do WhatsApp', rapid_failure: 'Chamada caiu rápido',
};
const stateLabels: Record<string, string> = { healthy: 'Saudável', attention: 'Atenção', degraded: 'Em risco', blocked: 'Bloqueada', insufficient_data: 'Poucos dados' };
const stateMeaning: Record<string, string> = {
  healthy: 'Dá para operar no ritmo atual e até aumentar com cuidado.',
  attention: 'Dá para operar, mas há sinais que merecem ação antes de acelerar.',
  degraded: 'Reduza o ritmo e resolva os sinais abaixo antes de continuar.',
  blocked: 'Nenhuma chamada nova deve sair agora. Veja o motivo abaixo.',
  insufficient_data: 'Ainda há poucas chamadas ou linhas para avaliar. A nota melhora conforme a operação roda.',
};
const stateTone = (state: string): 'success' | 'warning' | 'error' | 'info' => state === 'healthy' ? 'success' : state === 'blocked' || state === 'degraded' ? 'error' : state === 'attention' ? 'warning' : 'info';
const reasonLabel = (reason: string) => reasonLabels[reason] ?? reason.replaceAll('_', ' ');
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const bounded = (value: unknown) => Math.max(0, Math.min(100, Number(value) || 0));

function StateBadge({ state }: { state: string }) {
  return <Badge tone={stateTone(state)}><i className="badge-dot" />{stateLabels[state] ?? state}</Badge>;
}

function ScoreRing({ score, state, small = false }: { score: number; state: string; small?: boolean }) {
  const value = bounded(score);
  return <div className={`score-ring score-ring-${stateTone(state)}${small ? ' small' : ''}`} style={{ '--ring-fill': `${value * 3.6}deg` } as CSSProperties} role="img" aria-label={`Nota ${value} de 100`}>
    <div><strong>{value}</strong><small>de 100</small></div>
  </div>;
}

function ComponentList({ components = [] }: { components?: AnyRow[] }) {
  return <div className="signal-list">{components.map((component) => {
    const copy = componentCopy[String(component.code)] ?? { label: reasonLabel(String(component.code)), meaning: '', unit: '' };
    const score = bounded(component.score);
    return <article className="signal-row" key={component.code}>
      <div className="signal-copy"><strong>{copy.label}</strong><small>{copy.meaning}</small></div>
      <div className="bar-track" aria-hidden="true"><span className={`bar-fill bar-${score >= 80 ? 'success' : score >= 60 ? 'warning' : 'error'}`} style={{ width: `${score}%` }} /></div>
      <div className="signal-value"><strong>{Number(component.numerator) || 0} de {Number(component.denominator) || 0}</strong><small>{copy.unit ? `${copy.unit} · ` : ''}peso {Math.round((Number(component.weight) || 0) * 100)}%</small></div>
    </article>;
  })}</div>;
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
      const [current, previous, numberPage] = await Promise.all([json(`/api/tenants/${tenantId}/operation-health`), json(`/api/tenants/${tenantId}/operation-health/history?limit=12`), json('/api/numbers?limit=100')]);
      setHealth(current); setHistory(previous.items ?? []); setNumbers(numberPage.items ?? []); setError('');
      setSelectedNumberId((currentId) => currentId || numberPage.items?.[0]?.id || '');
    } catch (value) { setError(value instanceof Error ? value.message : 'Não foi possível carregar a saúde da operação.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000); return () => window.clearInterval(timer); }, [enabled, tenantId]);
  useEffect(() => {
    if (!selectedNumberId || !enabled || !tenantId) { setNumberHealth(null); setEvents([]); return; }
    let cancelled = false;
    void Promise.all([json(`/api/tenants/${tenantId}/numbers/${selectedNumberId}/health`), json(`/api/tenants/${tenantId}/numbers/${selectedNumberId}/health/events?limit=30`)])
      .then(([current, timeline]) => { if (!cancelled) { setNumberHealth(current); setEvents(timeline.items ?? []); } })
      .catch((value) => { if (!cancelled) setError(value instanceof Error ? value.message : 'Não foi possível carregar o detalhe da linha.'); });
    return () => { cancelled = true; };
  }, [enabled, tenantId, selectedNumberId]);

  if (!enabled) return <FeatureOff title="Saúde da operação ainda não está ligada para esta empresa" description="Esta página resume, em uma nota de 0 a 100, se a operação consegue discar agora com segurança: linhas conectadas, chamadas falhando, SDRs disponíveis e proteções ativas." />;
  if (loading && !health) return <LoadingBlock>Calculando os sinais da operação…</LoadingBlock>;
  if (error && !health) return <Panel><EmptyGuide icon="alert" title="Não foi possível calcular a saúde agora" text={error} action={{ label: 'Tentar novamente', icon: 'refresh', onClick: () => void load() }} /></Panel>;
  if (!health) return null;

  const capacity = health.evidence?.capacity ?? {};
  const queue = health.evidence?.queue ?? {};
  const trend = health.trend?.direction === 'up' ? 'Melhorando' : health.trend?.direction === 'down' ? 'Piorando' : 'Estável';

  return <div className="guide-page operation-health-page">
    <PageIntro
      eyebrow="OPERAÇÃO"
      title="Saúde da operação"
      purpose="Uma nota de 0 a 100 que responde a uma pergunta: dá para discar agora com segurança? Abaixo, o que puxa a nota para baixo e o que fazer antes de aumentar o ritmo."
      aside={<div className="guide-heading-meta"><small>Atualizado {dateTime(health.collectedAt)} · recalcula a cada 30 s</small><Button variant="ghost" onClick={() => navigateToTab('dashboard')}>Voltar à visão geral</Button></div>}
    />
    {error && <Notice tone="error">{error}</Notice>}

    <section className={`state-hero state-hero-${stateTone(health.state)}`}>
      <ScoreRing score={health.score} state={health.state} />
      <div className="state-hero-copy">
        <div className="state-hero-title"><StateBadge state={health.state} /><span className="state-hero-trend"><Icon name="activity" size={13} />{trend}</span></div>
        <h2>{stateMeaning[health.state] ?? stateLabels[health.state] ?? health.state}</h2>
        <div className="state-hero-action"><span className="eyebrow">O QUE FAZER AGORA</span><p>{health.nextSafeAction}</p></div>
      </div>
      <FactGrid columns={2} facts={[
        { label: 'Chamadas avaliadas', value: health.sampleSize?.attempts ?? 0, hint: 'na janela recente' },
        { label: 'Linhas avaliadas', value: health.sampleSize?.numbers ?? 0, hint: 'cadastradas na empresa' },
      ]} />
    </section>

    <div className="two-column">
      <Panel>
        <SectionHeader title="O que compõe a nota" description="Seis sinais, cada um com um peso. A barra mostra quão bem cada sinal está agora." />
        <ComponentList components={health.components} />
        {(health.reasonCodes ?? []).length > 0 && <div className="chip-block"><strong>Sinais de atenção</strong><div className="chip-list">{(health.reasonCodes ?? []).map((reason: string) => <span className="chip chip-warning" key={reason}><Icon name="alert" size={12} />{reasonLabel(reason)}</span>)}</div></div>}
        <TechnicalDetails><p className="subtle">{health.internalScoreNotice} Fórmula {health.formulaVersion}: nota = soma de (sinal × peso). Bloqueios de agenda ou política zeram a nota.</p></TechnicalDetails>
      </Panel>
      <Panel>
        <SectionHeader title="Capacidade agora" description="Quantas chamadas podem acontecer ao mesmo tempo e o que está esperando." />
        <FactGrid columns={2} facts={[
          { label: 'Posições livres', value: capacity.available ?? 0, hint: `de ${capacity.configured ?? 0} configuradas` },
          { label: 'Chamadas em andamento', value: capacity.active ?? 0, hint: 'ocupando posições' },
          { label: 'Leads prontos', value: queue.ready ?? 0, hint: `${queue.waiting ?? 0} aguardando intervalo` },
          { label: 'Retornos vencidos', value: queue.dueCallbacks ?? 0, hint: 'agendados e não feitos' },
        ]} />
        <div className="inline-fact"><Icon name="clock" size={15} /><div><strong>{capacity.nextReleaseAt ? `Próxima linha liberada ${dateTime(capacity.nextReleaseAt)}` : 'Nenhuma linha em pausa protetora ou quarentena'}</strong><small>Pausas protetoras e quarentenas terminam sozinhas; não é preciso intervir.</small></div></div>
      </Panel>
    </div>

    <Panel>
      <SectionHeader title="Tendência da saúde" description="As últimas medições, da mais antiga para a mais recente." />
      {history.length ? <div className="bar-list">{history.slice().reverse().map((item: AnyRow) => <div className="bar-row" key={item.id}><time>{dateTime(item.createdAt)}</time><div className="bar-track"><span className={`bar-fill bar-${stateTone(item.state)}`} style={{ width: `${bounded(item.score)}%` }} /></div><strong>{item.score}</strong><StateBadge state={item.state} /></div>)}</div> : <EmptyGuide icon="history" title="O histórico começa na próxima medição" text="A cada medição, um ponto aparece aqui para você ver se a operação está melhorando ou piorando." />}
    </Panel>

    <Panel>
      <SectionHeader title="Linha por linha" description="Cada número de WhatsApp tem a própria nota e as próprias proteções. Escolha um para ver o que aconteceu com ele." />
      <div className="split-layout split-layout-compact">
        <div className="pick-list">{numbers.length ? numbers.map((number) => <button type="button" className={'pick-item' + (selectedNumberId === number.id ? ' is-selected' : '')} key={number.id} onClick={() => setSelectedNumberId(number.id)}><span className="pick-icon"><Icon name="phone" size={15} /></span><span className="pick-copy"><strong>{number.label}</strong><small>{number.status}</small></span><Icon name="chevron" size={14} /></button>) : <EmptyGuide icon="phone" title="Nenhuma linha cadastrada" text="Conecte um número em Números para acompanhar a saúde dele aqui." />}</div>
        {numberHealth ? <div className="detail-card">
          <div className="detail-heading">
            <div><span className="eyebrow">LINHA</span><h3>{numberHealth.label}</h3><small>{numberHealth.status} · atualizado {dateTime(numberHealth.collectedAt)}</small></div>
            <ScoreRing score={numberHealth.score} state={numberHealth.state} small />
          </div>
          <div className="status-explainer"><StateBadge state={numberHealth.state} /><p>{numberHealth.nextSafeAction}</p></div>
          <FactGrid columns={3} facts={[
            { label: 'Pausa protetora', value: numberHealth.protection?.cooldown ? 'Ativa' : 'Não', hint: 'espera curta após chamadas' },
            { label: 'Quarentena', value: numberHealth.protection?.quarantine ? 'Ativa' : 'Não', hint: 'pausa longa após falhas seguidas' },
            { label: 'Volta a discar', value: numberHealth.protection?.nextReleaseAt ? dateTime(numberHealth.protection.nextReleaseAt) : 'Já pode', hint: 'fim da proteção' },
          ]} />
          <ComponentList components={numberHealth.components} />
          <div className="timeline">
            <strong>O que aconteceu com esta linha</strong>
            {events.length ? events.map((event) => <div className="timeline-row" key={event.id}><span className={`timeline-dot ${event.actorType === 'human' ? 'human' : 'automatic'}`} /><div><strong>{reasonLabel(String(event.eventType))}</strong><small>{event.actorType === 'human' ? 'Ação de uma pessoa' : 'Automático'} · {dateTime(event.occurredAt)}</small></div></div>) : <p className="subtle">Nenhum evento recente nesta linha.</p>}
          </div>
        </div> : <EmptyGuide icon="phone" title="Escolha uma linha ao lado" text="Você verá a nota dela, se está protegida e a lista do que aconteceu." />}
      </div>
    </Panel>

    <Panel>
      <SectionHeader title="Como ler esta página" description="Três coisas para ter em mente." />
      <HowItWorks items={[
        { icon: 'activity', title: 'A nota é interna', text: 'É um resumo do ZapLiga sobre a sua operação. Não é uma nota do WhatsApp nem garante que nada será bloqueado.' },
        { icon: 'lock', title: 'Proteções são automáticas', text: 'Pausa protetora e quarentena existem para a linha não ser bloqueada. Elas terminam sozinhas; forçar a saída delas aumenta o risco.' },
        { icon: 'check', title: 'Aja pelo “o que fazer agora”', text: 'A frase em destaque é sempre o passo mais seguro para o momento. Depois dele, a nota tende a subir.' },
      ]} />
    </Panel>
  </div>;
}

export { OperationHealthPage };
