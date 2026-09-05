import { useEffect, useState } from 'react';
import { Badge, Button, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';

const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const percent = (value: unknown) => `${Math.round(Number(value || 0) * 100)}%`;
const sampleText = (value: unknown) => `${Number(value || 0)} tentativas`;
const windowLabel = (value: string) => {
  const [day, hour] = value.split(':');
  return `${days[Number(day)] ?? 'Janela'} às ${String(Number(hour)).padStart(2, '0')}h`;
};
const dimensionLabel = (type: string, value: string) => type === 'best_time' ? windowLabel(value) : value === 'legacy' ? 'Operação legada' : value.replaceAll('_', ' ');
const tone = (status: string) => status === 'reliable' ? 'success' : status === 'attention' ? 'warning' : 'info';
const monitorTone = (status: string) => status === 'stable' || status === 'observed' ? 'success' : status === 'attention' ? 'warning' : 'info';
const monitorLabel = (status: string) => status === 'stable' ? 'Estável' : status === 'observed' ? 'Observado' : status === 'attention' ? 'Atenção' : 'Dados insuficientes';

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
      const [insights, aggregates, monitorData] = await Promise.all([
        json(`/api/tenants/${tenantId}/analytics/learning/insights`),
        json(`/api/tenants/${tenantId}/analytics/learning/aggregates?dimension=day_hour`),
        json(`/api/tenants/${tenantId}/analytics/learning/monitor`),
      ]);
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

  if (!enabled) return <Panel><div className="analytics-learning-empty"><Icon name="lock" size={22} /><strong>Aprendizado ainda não habilitado</strong><p>Os sinais históricos só aparecem após a ativação deste recurso para a empresa.</p></div></Panel>;
  if (loading && !data) return <div className="analytics-learning-page"><div className="analytics-learning-loading">Lendo sinais históricos…</div></div>;

  const reliability = data?.reliability ?? {};
  const insights = data?.insights ?? [];
  return <div className="analytics-learning-page">
    <div className="analytics-learning-heading"><div><span className="eyebrow">APRENDIZADO POR TENANT</span><h1>Aprendizado da operação</h1><p>Estatística descritiva para encontrar padrões sem transformar pouca amostra em promessa.</p></div><Button variant="secondary" icon="refresh" onClick={() => void rebuild()} disabled={rebuilding}>{rebuilding ? 'Recalculando…' : 'Recalcular sinais'}</Button></div>
    {error && <div className="analytics-learning-error" role="alert">{error}</div>}
    <Panel className="analytics-learning-guardrail"><div><Icon name="lock" size={17} /><div><strong>Guardrail ativo</strong><p>Esses sinais não alteram a fila ativa. O motor só os observa no modo shadow, com amostra mínima de {data?.minimumSampleSize ?? 20} tentativas.</p></div></div><Badge tone={tone(reliability.status)}>{reliability.status === 'reliable' ? 'Dados confiáveis' : 'Dados insuficientes'}</Badge></Panel>
    <Panel><SectionHeader eyebrow="MONITOR DE QUALIDADE" title="Estabilidade e seleção" description="Alertas descritivos para evitar que concentração da amostra pareça uma causa." /><div className="analytics-learning-monitor-grid"><div className="analytics-learning-monitor-card"><div><span>Estabilidade por linha</span><Badge tone={monitorTone(monitor?.stability?.status)}>{monitorLabel(monitor?.stability?.status ?? 'insufficient_data')}</Badge></div><strong>{monitor?.stability?.lines?.length ?? 0} linhas com amostra mínima</strong><small>Maior variação de falha: {percent(monitor?.stability?.maxLineFailureDelta)}</small></div><div className="analytics-learning-monitor-card"><div><span>Concentração observada</span><Badge tone={monitorTone(monitor?.selectionBias?.status)}>{monitorLabel(monitor?.selectionBias?.status ?? 'insufficient_data')}</Badge></div><strong>{percent(monitor?.selectionBias?.concentration)} na origem dominante</strong><small>{monitor?.selectionBias?.dominantSource ?? 'Sem origem dominante'} · {percent(monitor?.selectionBias?.retryShare)} em tentativas posteriores</small></div></div>{monitor?.selectionBias?.warnings?.length ? <div className="analytics-learning-monitor-warning"><Icon name="alert" size={15} /><span>{monitor.selectionBias.warnings.join(' ')}</span></div> : null}</Panel>
    <div className="analytics-learning-summary"><Panel><span>Confiabilidade</span><strong>{reliability.score ?? 0}/100</strong><small>fórmula {reliability.formulaVersion ?? '—'}</small></Panel><Panel><span>Período</span><strong>{data?.period?.from ? new Date(data.period.from).toLocaleDateString('pt-BR') : '—'}</strong><small>até {data?.period?.to ? new Date(data.period.to).toLocaleDateString('pt-BR') : '—'}</small></Panel><Panel><span>Estado do aprendizado</span><strong>{data?.status === 'ready' ? 'Pronto' : 'Insuficiente'}</strong><small>{data?.insights?.length ?? 0} insights elegíveis</small></Panel></div>
    <Panel><SectionHeader eyebrow="INSIGHTS EXPLICÁVEIS" title="O que os dados sugerem" description={data?.message} />{insights.length ? <div className="analytics-learning-insights">{insights.map((item: AnyRow) => <article className="analytics-learning-insight" key={item.type}><div className="analytics-learning-insight-icon"><Icon name={item.type === 'best_time' ? 'clock' : item.type.includes('campaign') ? 'sparkles' : 'chart'} size={16} /></div><div><strong>{item.title}</strong><h3>{dimensionLabel(item.type, String(item.dimensionValue))}</h3><p>{item.explanation}</p><small>{item.metric?.includes('Rate') ? percent(item.value) : item.value} · {sampleText(item.denominator)} · confiança {item.confidence}</small></div></article>)}</div> : <div className="analytics-learning-empty-inline"><Icon name="chart" size={18} /><strong>Dados insuficientes para recomendar um padrão</strong><span>Recalcule depois de acumular mais chamadas e executar uma reconciliação confiável.</span></div>}</Panel>
    <Panel><SectionHeader eyebrow="MELHORES HORÁRIOS" title="Janelas de atendimento" description="Taxa suavizada para reduzir oscilações de amostras pequenas." />{windows.length ? <div className="analytics-learning-window-list">{windows.slice(0, 8).map((item: AnyRow) => <div className="analytics-learning-window" key={item.id}><span>{windowLabel(String(item.dimensionValue))}</span><div className="analytics-learning-track"><i style={{ width: `${Math.min(100, Number(item.smoothedMetrics?.answerRate ?? 0) * 100)}%` }} /></div><strong>{percent(item.smoothedMetrics?.answerRate)}</strong><small>{sampleText(item.sampleSize)}</small></div>)}</div> : <div className="analytics-learning-empty-inline">Ainda não há agregados calculados para o período.</div>}</Panel>
  </div>;
}
