import { useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FeatureOff, HowItWorks, LoadingBlock, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const percent = (value: unknown) => `${Math.round(Number(value || 0) * 100)}%`;
const sampleText = (value: unknown) => `${Number(value || 0)} tentativas`;
const windowLabel = (value: string) => { const [day, hour] = value.split(':'); return `${days[Number(day)] ?? 'Janela'} às ${String(Number(hour)).padStart(2, '0')}h`; };
const dimensionLabel = (type: string, value: string) => type === 'best_time' ? windowLabel(value) : value === 'legacy' ? 'Operação sem campanha' : value.replaceAll('_', ' ');

// Titles the API sends are fine; what a leader needs is the question each
// insight answers and how much to trust it.
const insightQuestion: Record<string, string> = { best_time: 'Quando ligar?', campaign_positive_rate: 'Qual campanha rende mais?', source_positive_rate: 'Qual origem de leads rende mais?', best_recency: 'Quanto tempo depois do cadastro ligar?' };
const insightIcon: Record<string, string> = { best_time: 'clock', campaign_positive_rate: 'sparkles', source_positive_rate: 'users', best_recency: 'calendar' };
const confidenceLabel: Record<string, string> = { reliable: 'Base sólida', directional: 'Tendência inicial', insufficient_data: 'Amostra pequena' };
const confidenceTone: Record<string, string> = { reliable: 'success', directional: 'info', insufficient_data: 'neutral' };
const monitorLabel = (status?: string) => status === 'stable' || status === 'observed' ? 'Sem alerta' : status === 'attention' ? 'Atenção' : 'Poucos dados';
const monitorTone = (status?: string) => status === 'stable' || status === 'observed' ? 'success' : status === 'attention' ? 'warning' : 'neutral';
const dateOnly = (value?: string) => value ? new Date(value).toLocaleDateString('pt-BR') : '—';

export function AnalyticsLearningPage({ tenantId, enabled }: { tenantId: string; enabled: boolean }) {
  const [data, setData] = useState<AnyRow | null>(null);
  const [windows, setWindows] = useState<AnyRow[]>([]);
  const [monitor, setMonitor] = useState<AnyRow | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    if (!enabled || !tenantId) return;
    setLoading(true);
    try {
      const [insights, aggregates, monitorData] = await Promise.all([json(`/api/tenants/${tenantId}/analytics/learning/insights`), json(`/api/tenants/${tenantId}/analytics/learning/aggregates?dimension=day_hour`), json(`/api/tenants/${tenantId}/analytics/learning/monitor`)]);
      setData(insights); setWindows(aggregates.items ?? []); setMonitor(monitorData); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [tenantId, enabled]);

  const rebuild = async () => {
    setRebuilding(true); setError('');
    try { await json(`/api/tenants/${tenantId}/analytics/learning/rebuild`, { method: 'POST' }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRebuilding(false); }
  };

  if (!enabled) return <FeatureOff title="Aprendizado da operação ainda não está ligado para esta empresa" description="Esta página lê o histórico de chamadas e mostra padrões simples: melhores horários, campanhas e origens que mais rendem. É só leitura; nada aqui muda a fila." />;
  if (loading && !data) return <LoadingBlock>Lendo o histórico de chamadas…</LoadingBlock>;

  const reliability = data?.reliability ?? {};
  const reliable = reliability.status === 'reliable';
  const insights: AnyRow[] = data?.insights ?? [];
  const minimum = data?.minimumSampleSize ?? 20;
  const topWindows = windows.slice().sort((a, b) => Number(b.smoothedMetrics?.answerRate ?? 0) - Number(a.smoothedMetrics?.answerRate ?? 0)).slice(0, 8);

  return <div className="guide-page analytics-learning-page">
    <PageIntro
      eyebrow="OPERAÇÃO"
      title="Aprendizado da operação"
      purpose="O que o seu histórico de chamadas mostra: em que horários as pessoas mais atendem, quais campanhas e origens rendem mais. É leitura para decidir melhor; nada aqui altera a fila sozinho."
      aside={<Button variant="secondary" icon="refresh" onClick={() => void rebuild()} disabled={rebuilding}>{rebuilding ? 'Recalculando…' : 'Recalcular agora'}</Button>}
    />
    {error && <Notice tone="error">{error}</Notice>}

    <Panel className={`readiness readiness-${reliable ? 'ok' : 'wait'}`}>
      <span className="readiness-icon"><Icon name={reliable ? 'check' : 'clock'} size={18} /></span>
      <div>
        <strong>{reliable ? 'Há dados suficientes para ler padrões' : 'Ainda faltam dados para ler padrões com segurança'}</strong>
        <p>{reliable ? `Período analisado: ${dateOnly(data?.period?.from)} a ${dateOnly(data?.period?.to)}. Cada padrão abaixo diz em quantas tentativas se baseia.` : `Cada padrão precisa de pelo menos ${minimum} tentativas no mesmo recorte e de um histórico consistente. Continue operando e recalcule depois.`}</p>
      </div>
      <Badge tone={reliable ? 'success' : 'neutral'}>{reliable ? 'Pronto para ler' : 'Aguardando volume'}</Badge>
    </Panel>

    <Panel>
      <SectionHeader title="O que os dados sugerem" description={reliable ? 'Cada cartão responde a uma pergunta prática e mostra o tamanho da base.' : 'Os padrões aparecem aqui quando houver volume suficiente.'} />
      {insights.length ? <div className="insight-grid">{insights.map((item: AnyRow) => <article className="insight-card" key={item.type}>
        <span className="insight-card-icon"><Icon name={insightIcon[item.type] ?? 'chart'} size={16} /></span>
        <div className="insight-card-body">
          <span className="insight-question">{insightQuestion[item.type] ?? item.title}</span>
          <h3>{dimensionLabel(item.type, String(item.dimensionValue))}</h3>
          <p>{item.metric?.includes('Rate') ? `${percent(item.value)} de ${item.metric === 'answerRate' ? 'atendimento' : 'resultado positivo'}` : String(item.value)} · com base em {sampleText(item.denominator)}</p>
          <div className="insight-card-foot"><Badge tone={confidenceTone[item.confidence] ?? 'neutral'}>{confidenceLabel[item.confidence] ?? item.confidence}</Badge><small>{item.explanation}</small></div>
        </div>
      </article>)}</div> : <EmptyGuide icon="chart" title="Nenhum padrão para mostrar ainda" text={`Um padrão só aparece quando um recorte (horário, campanha, origem) acumula ${minimum} tentativas ou mais. Isso evita tomar coincidência por regra.`} />}
    </Panel>

    <Panel>
      <SectionHeader title="Melhores horários para ligar" description="Taxa de atendimento por dia e hora, do melhor para o pior. Barras mais longas atendem mais." />
      {topWindows.length ? <div className="bar-list">{topWindows.map((item: AnyRow) => <div className="bar-row" key={item.id}><span className="bar-label">{windowLabel(String(item.dimensionValue))}</span><div className="bar-track"><span className="bar-fill bar-primary" style={{ width: `${Math.min(100, Number(item.smoothedMetrics?.answerRate ?? 0) * 100)}%` }} /></div><strong>{percent(item.smoothedMetrics?.answerRate)}</strong><small>{sampleText(item.sampleSize)}</small></div>)}</div> : <EmptyGuide icon="clock" title="Ainda sem horários calculados" text="Depois de algumas semanas de chamadas, os horários com mais atendimento aparecem aqui." />}
    </Panel>

    <Panel>
      <SectionHeader title="Cuidados na leitura" description="Dois avisos automáticos para não confundir coincidência com causa." />
      <div className="two-column">
        <div className="care-card"><div className="care-head"><strong>As linhas se comportam parecido?</strong><Badge tone={monitorTone(monitor?.stability?.status)}>{monitorLabel(monitor?.stability?.status)}</Badge></div><p>{monitor?.stability?.lines?.length ?? 0} linha(s) com volume suficiente para comparar. Maior diferença de falha entre linhas: {percent(monitor?.stability?.maxLineFailureDelta)}.</p><small>Se uma linha falha muito mais que as outras, o problema pode ser dela, não do horário ou da campanha.</small></div>
        <div className="care-card"><div className="care-head"><strong>Os dados vêm de um lugar só?</strong><Badge tone={monitorTone(monitor?.selectionBias?.status)}>{monitorLabel(monitor?.selectionBias?.status)}</Badge></div><p>{percent(monitor?.selectionBias?.concentration)} das tentativas vêm da origem “{monitor?.selectionBias?.dominantSource ?? 'não identificada'}”. {percent(monitor?.selectionBias?.retryShare)} são segundas tentativas ou posteriores.</p><small>Quando quase tudo vem de uma origem, um “melhor horário” pode ser só o horário em que essa origem chega.</small></div>
      </div>
      {monitor?.selectionBias?.warnings?.length ? <Notice tone="warning">{monitor.selectionBias.warnings.join(' ')}</Notice> : null}
    </Panel>

    <Panel>
      <SectionHeader title="Como isto funciona" />
      <HowItWorks items={[
        { icon: 'lock', title: 'Só leitura', text: 'Nada aqui muda a fila. O motor de decisão pode observar estes padrões, mas só age quando você liga a fila inteligente em uma campanha.' },
        { icon: 'chart', title: 'Amostra mínima', text: `Um recorte só vira padrão com ${minimum} tentativas ou mais. Números pequenos oscilam muito para servir de guia.` },
        { icon: 'refresh', title: 'Recalcule quando quiser', text: 'O botão “Recalcular agora” refaz a leitura com as chamadas mais recentes.' },
      ]} />
      <TechnicalDetails><p className="subtle">Confiabilidade do histórico: {reliability.score ?? 0}/100 (fórmula {reliability.formulaVersion ?? '—'}). Taxas são suavizadas para reduzir oscilação de amostras pequenas. Estado: {data?.status ?? '—'} · {data?.message ?? ''}</p></TechnicalDetails>
    </Panel>
  </div>;
}
