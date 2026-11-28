import { useCallback, useEffect, useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { EmptyGuide, FactGrid, LoadingBlock, Notice, PageIntro, TechnicalDetails } from '../../components/guide';
import { DateRangePopover, type DateRange } from '../../components/DateRangePopover';
import { apiFetch, json } from '../../services/api';
import { useSingleFlight } from '../../shared/useSingleFlight';
import { useOperationsRealtime } from '../dashboard/useOperationsRealtime';
import { LOSS_CAUSE_LABEL, YOUNG_LINE_DAILY_CALLS } from '../numbers/lineLoss.copy';

type View = 'now' | 'period' | 'timeline' | 'history' | 'learnings';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'now', label: 'Agora' }, { key: 'period', label: 'Período' }, { key: 'timeline', label: 'Linha do tempo' },
  { key: 'history', label: 'Histórico' }, { key: 'learnings', label: 'Aprendizados' },
];
const REFRESH_MS = 30_000;
const HISTORY_DAYS = 30;
const CONNECTED = ['connected', 'online', 'ready', 'authenticated', 'logged_in'];
const STATUS_LABEL: Record<string, string> = { connected: 'Conectada', disconnected: 'Desconectada', waiting_for_qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando' };
const CANARY_LABEL: Record<string, string> = { pending: 'Aguardando canário', passed: 'Canário ok', failed: 'Canário reprovado' };
const CONFIDENCE: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  reliable: { label: 'Base sólida', tone: 'success' }, directional: { label: 'Tendência inicial', tone: 'warning' }, insufficient_data: { label: 'Amostra pequena', tone: 'neutral' },
};
const EVENT_LABEL: Record<string, string> = {
  canary_passed: 'Passou no canário', canary_failed: 'Reprovou no canário', quarantine_started: 'Entrou em quarentena', manual_protection: 'Protegida à mão',
  registration_reason: 'Recusa no registro anotada', waxum_node_changed: 'Trocou de saída', online: 'PC voltou a ter internet', offline: 'PC ficou sem internet',
  silent: 'PC parou de responder', note: 'Nota da equipe',
};
const EXPORTS: Array<{ dataset: string; label: string }> = [
  { dataset: 'lines', label: 'Linhas do período' }, { dataset: 'daily', label: 'Dia a dia' }, { dataset: 'losses', label: 'Quedas com a ficha' }, { dataset: 'timeline', label: 'Linha do tempo' },
];

const today = () => new Date().toLocaleDateString('en-CA');
const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return date.toLocaleDateString('en-CA'); };
const when = (value: unknown) => (value ? new Date(String(value)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
const minutes = (seconds: number, answered: number) => (answered ? `${Math.round(seconds / answered / 6) / 10} min` : '—');
const lossLabel = (cause?: string | null) => (cause ? LOSS_CAUSE_LABEL[cause] ?? cause : '');
const lossesText = (losses?: Record<string, number> | null) => Object.entries(losses ?? {}).map(([cause, total]) => `${lossLabel(cause)} ${total}`).join(' · ');
const query = (range: DateRange) => `from=${range.from}&to=${range.to}`;

function ExportButtons({ tenantId, range }: { tenantId: string; range: DateRange }) {
  const [error, setError] = useState('');
  const download = async (dataset: string) => {
    setError('');
    try {
      const response = await apiFetch(`/api/tenants/${tenantId}/line-monitor/export.csv?dataset=${dataset}&${query(range)}`);
      if (!response.ok) throw new Error('Não foi possível exportar');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `monitor-linhas-${dataset}-${range.from}_${range.to}.csv`; anchor.click(); URL.revokeObjectURL(url);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  return <div className="line-monitor-exports">
    {EXPORTS.map((item) => <Button key={item.dataset} variant="secondary" icon="download" onClick={() => void download(item.dataset)}>{item.label}</Button>)}
    {error && <Notice tone="error">{error}</Notice>}
  </div>;
}

function NowView({ data }: { data: AnyRow }) {
  const alerts: AnyRow[] = data.alerts ?? [];
  const lines: AnyRow[] = data.lines ?? [];
  const alertFor = (id: string) => alerts.filter((alert) => alert.numberId === id);
  return <>
    {alerts.length > 0 && <Panel>
      <SectionHeader title="Alertas" description="Avisos sobre PCs e linhas agora. Os que vêm dos aprendizados só aparecem quando há base para eles." />
      {alerts.map((alert, index) => <Notice key={`${alert.kind}-${index}`} tone={alert.kind === 'pc_offline' ? 'error' : 'warning'}>{alert.message}</Notice>)}
    </Panel>}
    <Panel>
      <SectionHeader title="Saídas de internet" description="PCs e proxies por onde as linhas saem, e quantas linhas desta empresa estão em cada um." />
      <div className="line-monitor-exits">{(data.exits ?? []).map((exit: AnyRow) => <article className="detail-card" key={exit.id}>
        <div className="line-monitor-exit-head"><strong>{exit.name}</strong><Badge tone={exit.online ? 'success' : 'error'}>{exit.online ? 'Online' : 'Sem internet'}</Badge></div>
        <small>{exit.kind === 'proxy' ? 'Proxy' : 'PC'} · {exit.slot} · {exit.lines} linha(s)</small>
        {!exit.online && exit.offline_since && <small>Sem internet desde {when(exit.offline_since)}</small>}
        {exit.online && exit.online_since && <small>Online desde {when(exit.online_since)}</small>}
      </article>)}</div>
    </Panel>
    <Panel>
      <SectionHeader title="Linhas" description={`Estado de cada linha agora. Linhas novas têm limite de ${YOUNG_LINE_DAILY_CALLS} ligações por dia.`} />
      <div className="table-container"><div className="table-scroll"><table>
        <thead><tr><th>Linha</th><th>Status</th><th>Saída</th><th>Canário</th><th>Hoje</th><th>Reconexões 24 h</th><th>Quedas em 30 dias</th><th>Alertas</th></tr></thead>
        <tbody>{lines.map((line) => <tr key={line.id}>
          <td><strong>{line.label}</strong></td>
          <td><Badge tone={line.loss_reason ? 'error' : CONNECTED.includes(String(line.status)) ? 'success' : 'warning'}>{line.loss_reason ? lossLabel(line.loss_reason) : STATUS_LABEL[line.status] ?? line.status}</Badge></td>
          <td>{line.waxum_node}</td>
          <td>{CANARY_LABEL[line.canary_status] ?? line.canary_status}</td>
          <td>{line.young ? `${line.calls_today ?? 0}/${YOUNG_LINE_DAILY_CALLS}` : line.calls_today ?? 0}</td>
          <td>{line.reconnects_24h ?? 0}</td>
          <td>{lossesText(line.losses_recent) || '—'}</td>
          <td>{alertFor(line.id).map((alert) => <Badge key={alert.kind} tone="warning">{alert.kind === 'near_fall_point' ? 'Perto do ponto de queda' : alert.kind === 'many_1005' ? 'Muitas 1005' : 'Recém-movida'}</Badge>)}</td>
        </tr>)}</tbody>
      </table></div></div>
    </Panel>
  </>;
}

function StatsTable({ rows, first, firstKey }: { rows: AnyRow[]; first: string; firstKey: string }) {
  return <div className="table-container"><div className="table-scroll"><table>
    <thead><tr><th>{first}</th><th>Ligações</th><th>Atendidas</th><th>Taxa</th><th>Conversa média</th><th>Caíram (1005)</th></tr></thead>
    <tbody>{rows.map((row, index) => <tr key={`${row[firstKey]}-${index}`}>
      <td><strong>{firstKey === 'hour' ? `${row.hour}h` : row[firstKey]}</strong></td><td>{row.calls}</td><td>{row.answered}</td><td>{pct(row.answered, row.calls)}</td>
      <td>{minutes(row.talk_seconds, row.answered)}</td><td>{row.closed_1005}</td>
    </tr>)}</tbody>
  </table></div></div>;
}

function PeriodView({ data, tenantId, range }: { data: AnyRow; tenantId: string; range: DateRange }) {
  const totals = data.totals ?? {};
  return <>
    <Panel>
      <SectionHeader title="Resumo do período" description="Ligações para leads; as ligações do canário ficam de fora." />
      <FactGrid columns={4} facts={[
        { label: 'Ligações', value: totals.calls ?? 0, hint: `${totals.active_lines ?? 0} linhas ligaram` },
        { label: 'Atendidas', value: totals.answered ?? 0, hint: pct(totals.answered ?? 0, totals.calls ?? 0) },
        { label: 'Caíram com erro 1005', value: totals.closed_1005 ?? 0, hint: pct(totals.closed_1005 ?? 0, totals.calls ?? 0) },
        { label: 'Linhas perdidas', value: totals.lost_lines ?? 0, hint: 'removidas, travadas ou banidas' },
      ]} />
      <ExportButtons tenantId={tenantId} range={range} />
    </Panel>
    <Panel>
      <SectionHeader title="Por linha" description="Uma linha da tabela por número de WhatsApp." />
      <div className="table-container"><div className="table-scroll"><table>
        <thead><tr><th>Linha</th><th>Saída</th><th>Ligações</th><th>Atendidas</th><th>Taxa</th><th>Conversa média</th><th>1005</th><th>Falhas Waxum</th><th>Reconexões</th><th>Trocas de PC</th><th>Quedas</th></tr></thead>
        <tbody>{(data.lines ?? []).map((line: AnyRow) => <tr key={line.number_id}>
          <td><strong>{line.label}</strong></td><td>{line.waxum_node}</td><td>{line.calls}</td><td>{line.answered}</td><td>{pct(line.answered, line.calls)}</td>
          <td>{minutes(line.talk_seconds, line.answered)}</td><td>{line.closed_1005}</td><td>{line.waxum_failures}</td><td>{line.reconnects}</td><td>{line.node_moves}</td>
          <td>{line.lost ? <Badge tone="error">{lossLabel(line.loss_cause)}</Badge> : lossesText(line.losses) || '—'}</td>
        </tr>)}</tbody>
      </table></div></div>
    </Panel>
    <Panel><SectionHeader title="Por atendente" /><StatsTable rows={data.sdrs ?? []} first="Atendente" firstKey="name" /></Panel>
    <Panel><SectionHeader title="Por hora" /><StatsTable rows={data.hours ?? []} first="Hora" firstKey="hour" /></Panel>
  </>;
}

function describeEvent(item: AnyRow) {
  const detail = item.detail ?? {};
  if (item.kind === 'loss') {
    const context = detail.context;
    return `${lossLabel(item.code)}${context ? ` · ${context.callsSincePairing ?? '?'} ligações desde o pareamento, ${context.callsToday ?? '?'} hoje, saída ${context.waxumNode ?? '?'}` : ''}`;
  }
  if (item.kind === 'move') return `${EVENT_LABEL.waxum_node_changed}: ${detail.from ?? '?'} → ${detail.to ?? '?'}${detail.automatic ? ' (automático)' : ''}`;
  if (item.kind === 'note') return `${detail.body}${detail.author ? ` — ${detail.author}` : ''}`;
  if (item.kind === 'pc') return `${EVENT_LABEL[item.code] ?? item.code} (${detail.slot})`;
  return EVENT_LABEL[item.code] ?? item.code;
}

function TimelineView({ data, lines, tenantId, onChanged }: { data: AnyRow; lines: AnyRow[]; tenantId: string; onChanged: () => void }) {
  const [numberId, setNumberId] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const items: AnyRow[] = (data.items ?? []).filter((item: AnyRow) => !numberId || item.number_id === numberId || (item.kind === 'note' && !item.number_id));
  const save = async () => {
    setError('');
    try {
      await json(`/api/tenants/${tenantId}/line-monitor/notes`, { method: 'POST', body: JSON.stringify({ body, numberId: numberId || undefined }) });
      setBody(''); onChanged();
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  return <Panel>
    <SectionHeader title="Linha do tempo" description="Quedas (com a ficha da linha naquele momento), canário, quarentena, trocas de saída, quedas de PC e notas da equipe." />
    <div className="line-monitor-filters">
      <label>Linha <select value={numberId} onChange={(event) => setNumberId(event.target.value)}>
        <option value="">Todas</option>{lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
      </select></label>
    </div>
    <div className="line-monitor-note">
      <input value={body} maxLength={1000} placeholder="Anote o que a equipe mudou (ex.: liguei o Business nas linhas 12 e 13)" onChange={(event) => setBody(event.target.value)} aria-label="Nota da equipe" />
      <Button icon="plus" disabled={!body.trim()} onClick={() => void save()}>Anotar</Button>
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {items.length ? <div className="timeline">{items.map((item) => <div className="timeline-row" key={`${item.kind}-${item.id}`}>
      <span className={`timeline-dot${item.kind === 'note' ? ' human' : ''}`} />
      <div><strong>{item.label ?? 'Equipe'} · {describeEvent(item)}</strong><small>{when(item.at)}</small></div>
    </div>)}</div> : <EmptyGuide icon="clock" title="Nada aconteceu no período" text="Escolha outras datas ou outra linha." />}
  </Panel>;
}

function HistoryView({ data }: { data: AnyRow }) {
  const days: AnyRow[] = data.days ?? [];
  const max = Math.max(1, ...days.map((day) => Number(day.calls)));
  const width = 640;
  const height = 200;
  const step = days.length ? width / days.length : width;
  const noteDays = new Set((data.notes ?? []).map((note: AnyRow) => new Date(note.occurred_at).toLocaleDateString('en-CA')));
  return <Panel>
    <SectionHeader title="Histórico por dia" description="Barras: ligações. Parte escura: atendidas. Ponto vermelho: dia com linha perdida. Marca roxa: dia com nota da equipe." />
    {days.length ? <>
      <svg className="line-monitor-chart" viewBox={`0 0 ${width} ${height + 20}`} role="img" aria-label="Ligações e atendidas por dia">
        {days.map((day, index) => {
          const x = index * step + step * 0.15;
          const barWidth = step * 0.7;
          const callsHeight = (Number(day.calls) / max) * height;
          const answeredHeight = (Number(day.answered) / max) * height;
          return <g key={day.day}>
            <rect className="line-monitor-bar-calls" x={x} y={height - callsHeight} width={barWidth} height={callsHeight} />
            <rect className="line-monitor-bar-answered" x={x} y={height - answeredHeight} width={barWidth} height={answeredHeight} />
            {Number(day.lost_lines) > 0 && <circle className="line-monitor-dot-lost" cx={x + barWidth / 2} cy={height - callsHeight - 6} r={4} />}
            {noteDays.has(day.day) && <rect className="line-monitor-mark-note" x={x} y={height + 4} width={barWidth} height={4} />}
          </g>;
        })}
      </svg>
      <details className="metrics-alt-table"><summary>Ver em tabela</summary>
        <table><thead><tr><th>Dia</th><th>Ligações</th><th>Atendidas</th><th>1005</th><th>Linhas que ligaram</th><th>Linhas perdidas</th></tr></thead>
          <tbody>{days.map((day) => <tr key={day.day}><td>{day.day}{day.config_estimated ? ' *' : ''}</td><td>{day.calls}</td><td>{day.answered}</td><td>{day.closed_1005}</td><td>{day.active_lines}</td><td>{day.lost_lines}</td></tr>)}</tbody>
        </table>
        <small>* Dia refeito depois: a configuração da linha (PC, camuflagem) é a de hoje.</small>
      </details>
    </> : <EmptyGuide icon="chart" title="Ainda sem histórico" text="O histórico é montado a cada 15 minutos." />}
  </Panel>;
}

function LearningsView({ tenantId, data, runs, onChanged }: { tenantId: string; data: AnyRow | null; runs: AnyRow[]; onChanged: (run: AnyRow) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recompute = async () => {
    setBusy(true); setError('');
    try { onChanged(await json(`/api/tenants/${tenantId}/line-monitor/learnings/rebuild`, { method: 'POST', body: JSON.stringify({}) })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  const open = async (id: string) => {
    if (!id) return;
    try { onChanged(await json(`/api/tenants/${tenantId}/line-monitor/learnings/runs/${id}`)); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  const sample = data?.sample ?? {};
  return <>
    <Panel>
      <SectionHeader title="Aprendizados" description="O que os dados mostram sobre por que as linhas caem. Recalcula toda noite; cada cálculo fica salvo para comparar." />
      <div className="line-monitor-filters">
        <Button icon="refresh" disabled={busy} onClick={() => void recompute()}>{busy ? 'Calculando…' : 'Recalcular agora'}</Button>
        {runs.length > 0 && <label>Ver cálculo de <select value={data?.id ?? ''} onChange={(event) => void open(event.target.value)}>
          {runs.map((run) => <option key={run.id} value={run.id}>{when(run.computed_at)} · {run.period_start} a {run.period_end}{run.trigger === 'nightly' ? ' (noite)' : ''}</option>)}
        </select></label>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {data && <FactGrid columns={4} facts={[
        { label: 'Período', value: `${data.period_start} a ${data.period_end}` },
        { label: 'Linhas', value: sample.lines ?? 0, hint: `${sample.lineDays ?? 0} dias de linha` },
        { label: 'Ligações', value: sample.calls ?? 0 },
        { label: 'Quedas', value: sample.falls ?? 0, hint: `${sample.fallLines ?? 0} linhas` },
      ]} />}
    </Panel>
    {data ? <div className="insight-grid">{(data.findings ?? []).map((finding: AnyRow) => <article className="insight-card" key={finding.key}>
      <div className="insight-card-body">
        <span className="insight-question">{finding.question}</span>
        <h3>{finding.answer}</h3>
        <p>{finding.action}</p>
        {finding.groups?.length > 0 && <ul className="line-monitor-groups">{finding.groups.map((group: AnyRow) => <li key={group.label}>
          <span>{group.label}</span><small>{group.lines} linhas · {group.calls} ligações · {group.falls} quedas · {group.ratePer100} por 100</small>
        </li>)}</ul>}
        <div className="insight-card-foot"><Badge tone={CONFIDENCE[finding.confidence]?.tone ?? 'neutral'}>{CONFIDENCE[finding.confidence]?.label ?? finding.confidence}</Badge></div>
      </div>
    </article>)}</div> : <Panel><EmptyGuide icon="chart" title="Nenhum cálculo ainda" text="Clique em Recalcular agora ou espere o cálculo da noite." /></Panel>}
    <TechnicalDetails summary="Como os aprendizados são calculados">
      <p>Queda é quando o WhatsApp removeu, travou ou baniu a linha. A taxa é de quedas por 100 ligações, suavizada para grupos pequenos. A confiança depende de quantas linhas estão por trás do número: menos de 5 é amostra pequena, de 5 a 9 é tendência inicial, e 10 ou mais é base sólida. Perguntas sobre configuração (saída, camuflagem, perfil) só usam dias gravados no próprio dia.</p>
    </TechnicalDetails>
  </>;
}

export function LineMonitorPage({ tenantId }: { tenantId: string }) {
  const [view, setView] = useState<View>('now');
  const [range, setRange] = useState<DateRange>({ from: today(), to: today() });
  const [data, setData] = useState<Partial<Record<View, AnyRow | null>>>({});
  const [runs, setRuns] = useState<AnyRow[]>([]);
  const [lines, setLines] = useState<AnyRow[]>([]);
  const [error, setError] = useState('');
  const singleFlight = useSingleFlight();
  const { activity } = useOperationsRealtime(tenantId, view === 'now');

  const loadOnce = useCallback(async () => {
    const base = `/api/tenants/${tenantId}/line-monitor`;
    try {
      if (view === 'now') { const now = await json(`${base}/now`); setLines(now.lines ?? []); setData((current) => ({ ...current, now })); }
      if (view === 'period') { const period = await json(`${base}/period?${query(range)}`); setData((current) => ({ ...current, period })); }
      if (view === 'timeline') {
        const [timeline, now] = await Promise.all([json(`${base}/timeline?${query(range)}`), lines.length ? null : json(`${base}/now`)]);
        if (now) setLines(now.lines ?? []);
        setData((current) => ({ ...current, timeline }));
      }
      if (view === 'history') { const history = await json(`${base}/history?from=${daysAgo(HISTORY_DAYS - 1)}&to=${today()}`); setData((current) => ({ ...current, history })); }
      if (view === 'learnings') {
        const [learnings, list] = await Promise.all([json(`${base}/learnings`), json(`${base}/learnings/runs`)]);
        setRuns(list ?? []); setData((current) => ({ ...current, learnings }));
      }
      setError('');
    } catch (value) { setError(value instanceof Error ? value.message : 'Não foi possível carregar o monitor.'); }
  }, [lines.length, range, tenantId, view]);
  const load = useCallback(() => singleFlight(`line-monitor:${tenantId}:${view}:${range.from}:${range.to}`, loadOnce), [loadOnce, range.from, range.to, singleFlight, tenantId, view]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && view !== 'learnings') void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, view]);
  useEffect(() => { if (activity && view === 'now') void load(); }, [activity, load, view]);

  const current = data[view];
  const usesRange = view === 'period' || view === 'timeline';
  return <div className="guide-page line-monitor-page">
    <PageIntro
      eyebrow="ANÁLISES"
      title="Monitor de linhas"
      purpose="Como estão as linhas e os PCs agora, os números de cada período, o que aconteceu com cada linha e o que os dados ensinam sobre por que elas caem."
      aside={usesRange ? <DateRangePopover value={range} onChange={setRange} /> : undefined}
    />
    <div className="metrics-tabs" role="tablist" aria-label="Seções do monitor">
      {VIEWS.map((item) => <button key={item.key} type="button" role="tab" aria-selected={view === item.key} className={view === item.key ? 'is-active' : ''} onClick={() => setView(item.key)}>{item.label}</button>)}
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {current === undefined && !error && <LoadingBlock>Carregando…</LoadingBlock>}
    {view === 'now' && current && <NowView data={current} />}
    {view === 'period' && current && <PeriodView data={current} tenantId={tenantId} range={range} />}
    {view === 'timeline' && current && <TimelineView data={current} lines={lines} tenantId={tenantId} onChanged={() => void loadOnce()} />}
    {view === 'history' && current && <HistoryView data={current} />}
    {view === 'learnings' && current !== undefined && <LearningsView tenantId={tenantId} data={current} runs={runs}
      onChanged={(run) => { setData((value) => ({ ...value, learnings: run })); void json(`/api/tenants/${tenantId}/line-monitor/learnings/runs`).then((list) => setRuns(list ?? [])).catch(() => undefined); }} />}
  </div>;
}
