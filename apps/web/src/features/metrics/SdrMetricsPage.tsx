import { useEffect, useMemo, useState } from 'react';
import { DateRangePopover, formatDateRangeLabel, type DateRange } from '../../components/DateRangePopover';
import { Badge, EmptyState, Icon, Panel, SectionHeader } from '../../components/ui';
import { json } from '../../services/api';
import { formatCallResult, formatDurationCompact, formatNumber, formatPipelineStage, labelStatus } from '../../shared/format';
import type { AnyRow } from '../../types';

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const defaultRange = (): DateRange => ({ from: isoDate(new Date(Date.now() - 29 * 86400000)), to: isoDate(new Date()) });
const resultLabel = (code: string) => formatCallResult(code);
const dateLabel = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
const dateTimeLabel = (value: string) => new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function SdrMetricsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [data, setData] = useState<AnyRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void json(`/api/dialer/sdr-metrics?from=${range.from}&to=${range.to}`)
      .then((result) => { if (active) setData(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range.from, range.to]);

  const summary = data?.summary ?? {};
  const trend = (data?.trend ?? []) as AnyRow[];
  const outcomes = (data?.outcomes ?? []) as AnyRow[];
  const recent = (data?.recent ?? []) as AnyRow[];
  const maxCalls = useMemo(() => Math.max(1, ...trend.map((item) => Number(item.calls) || 0)), [trend]);
  const totalOutcomes = useMemo(() => outcomes.reduce((total, item) => total + (Number(item.count) || 0), 0), [outcomes]);

  return <div className="sdr-results-page">
    <div className="page-heading sdr-results-heading">
      <div><span className="eyebrow">DESEMPENHO PESSOAL</span><h1>Meus resultados</h1><p>Acompanhe sua evolução e os resultados das conversas que foram atribuídas a você.</p></div>
      <DateRangePopover value={range} onChange={setRange} />
    </div>

    {error && <div className="alert" role="alert"><Icon name="alert" size={17} /><span>{error}</span></div>}
    {loading && !data ? <Panel><div className="sdr-results-loading">Carregando seus resultados…</div></Panel> : <>
      {!data?.sdr && <Panel><EmptyState title="Perfil de SDR não encontrado" description="Peça ao gestor para vincular seu usuário a um perfil de SDR." /></Panel>}
      {data?.sdr && <>
        <div className="sdr-results-grid" aria-label={`Indicadores de ${formatDateRangeLabel(range)}`}>
          <ResultCard icon="phone" label="Tentativas" value={formatNumber(summary.calls)} detail="chamadas atribuídas" />
          <ResultCard icon="check" label="Conversas" value={formatNumber(summary.answered)} detail={`${summary.answer_rate ?? 0}% de atendimento`} tone="green" />
          <ResultCard icon="history" label="Tempo em conversa" value={formatDurationCompact(summary.conversation_seconds)} detail={`${formatDurationCompact(summary.average_conversation_seconds)} em média`} />
          <ResultCard icon="note" label="Tempo médio de registro" value={formatDurationCompact(summary.average_wrap_up_seconds)} detail={`${formatDurationCompact(summary.wrap_up_seconds)} no total`} />
          <ResultCard icon="sparkles" label="Resultados positivos" value={formatNumber(summary.positive)} detail="interessados e reuniões" tone="purple" />
          <ResultCard icon="calendar" label="Reuniões agendadas" value={formatNumber(summary.meetings)} detail="registradas no período" tone="orange" />
        </div>

        <div className="sdr-results-panels">
          <Panel>
            <SectionHeader eyebrow="EVOLUÇÃO" title="Atividade por dia" description="Tentativas e conversas atendidas no período." />
            {trend.length ? <div className="sdr-trend-list">
              {trend.map((item) => <div className="sdr-trend-row" key={item.day}>
                <time dateTime={item.day}>{dateLabel(item.day)}</time>
                <div className="sdr-trend-bar" aria-hidden="true"><span style={{ width: `${Math.max(3, (Number(item.calls) / maxCalls) * 100)}%` }} /></div>
                <div className="sdr-trend-values"><strong>{item.calls}</strong><span>{item.answered} {Number(item.answered) === 1 ? 'conversa' : 'conversas'}</span><small>{formatDurationCompact(item.conversation_seconds)}</small></div>
              </div>)}
            </div> : <EmptyState title="Sem atividade no período" description="Suas chamadas aparecerão aqui assim que forem realizadas." />}
          </Panel>

          <Panel>
            <SectionHeader eyebrow="RESULTADOS" title="Como terminaram as conversas" description="Distribuição dos registros feitos no pós-atendimento." />
            {outcomes.length ? <div className="sdr-outcome-list">
              {outcomes.map((item) => { const percentage = totalOutcomes ? Math.round((Number(item.count) / totalOutcomes) * 100) : 0; return <div className="sdr-outcome-row" key={item.code}>
                <div><strong>{resultLabel(item.code)}</strong><span>{percentage}%</span></div>
                <div className="sdr-outcome-bar"><span style={{ width: `${percentage}%` }} /></div>
                <small>{formatNumber(item.count)} {Number(item.count) === 1 ? 'chamada' : 'chamadas'}</small>
              </div>; })}
            </div> : <EmptyState title="Nenhum resultado registrado" description="Finalize uma conversa para começar a compor este resumo." />}
          </Panel>
        </div>

        <Panel className="sdr-recent-panel">
          <SectionHeader eyebrow="HISTÓRICO RECENTE" title="Minhas últimas ligações" description="As 10 chamadas mais recentes dentro do período selecionado." action={<Badge>{recent.length} exibidas</Badge>} />
          {recent.length ? <div className="table-scroll"><table className="sdr-recent-table"><thead><tr><th>Data</th><th>Contato</th><th>Status</th><th>Resultado</th><th>Etapa</th><th>Conversa</th></tr></thead><tbody>
            {recent.map((call) => <tr key={call.id}><td>{dateTimeLabel(call.created_at)}</td><td><strong>{call.lead_name || 'Contato manual'}</strong><small>{call.lead_phone || '—'}</small></td><td>{labelStatus(call.status)}</td><td>{formatCallResult(call.call_result)}</td><td>{formatPipelineStage(call.pipeline_stage)}</td><td>{formatDurationCompact(call.conversation_seconds)}</td></tr>)}
          </tbody></table></div> : <EmptyState title="Nenhuma ligação neste período" description="Altere o período ou aguarde suas próximas chamadas." />}
        </Panel>
      </>}
    </>}
  </div>;
}

function ResultCard({ icon, label, value, detail, tone = 'blue' }: { icon: string; label: string; value: string; detail: string; tone?: string }) {
  return <article className="sdr-result-card"><span className={`sdr-result-icon is-${tone}`}><Icon name={icon} size={17} /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}
