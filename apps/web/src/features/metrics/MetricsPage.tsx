import { useState } from 'react';
import type { AnyRow } from '../../types';
import { Badge, Button, Panel, SectionHeader } from '../../components/ui';
import { ActivityTrendChart } from './ActivityTrendChart';
import { DrilldownTarget, MetricDetailDrawer } from './MetricDetailDrawer';
import { FolderPerformanceTable } from './FolderPerformanceTable';
import { FunnelChart } from './FunnelChart';
import { downloadMetricsPdf } from './metrics.api';
import { METRIC_DEFINITIONS } from './metrics.definitions';
import { formatNumber } from './metrics.format';
import { MetricsAlerts } from './MetricsAlerts';
import { MetricsFilters } from './MetricsFilters';
import { MetricsGoals } from './MetricsGoals';
import { MetricsKpiGrid } from './MetricsKpiGrid';
import { NumberHealthTable } from './NumberHealthTable';
import { OutcomeBreakdown } from './OutcomeBreakdown';
import { SavedViewsPanel } from './SavedViewsPanel';
import { SdrPerformanceTable } from './SdrPerformanceTable';
import type { ReportPeriodPreset } from './metrics.types';
import { MetricsFiltersState, useMetrics } from './useMetrics';

const PDF_PERIOD_OPTIONS: [ReportPeriodPreset, string][] = [
  ['custom', 'Período dos filtros'], ['this_week', 'Esta semana'], ['last_week', 'Semana passada'],
  ['this_month', 'Este mês'], ['last_month', 'Mês passado'],
];

function PdfExportControl({ params }: { params: ReturnType<typeof useMetrics>['query'] }) {
  const [period, setPeriod] = useState<ReportPeriodPreset>('custom');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError('');
    try { await downloadMetricsPdf(params, period); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="metrics-pdf-export">
    <select value={period} onChange={(event) => setPeriod(event.target.value as ReportPeriodPreset)} aria-label="Período do relatório">
      {PDF_PERIOD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <Button variant="secondary" onClick={() => void run()} disabled={busy}>{busy ? 'Gerando…' : 'Exportar relatório PDF'}</Button>
    {error && <span className="metrics-export-error" role="alert">{error}</span>}
  </div>;
}

function RealtimeStrip({ realtime }: { realtime: NonNullable<ReturnType<typeof useMetrics>['summary']>['realtime'] }) {
  return <Panel>
    <SectionHeader eyebrow="TEMPO REAL" title="Operação agora" action={realtime.queueStalled ? <Badge tone="warning">Fila parada</Badge> : undefined} />
    <div className="folder-metric-grid metrics-realtime-grid">
      <div><span>Chamadas ativas</span><strong>{realtime.activeCalls}</strong></div>
      <div><span>SDRs disponíveis</span><strong>{realtime.sdrsAvailable}</strong></div>
      <div><span>SDRs em chamada</span><strong>{realtime.sdrsInCall}</strong></div>
      <div><span>SDRs em pós-atendimento</span><strong>{realtime.sdrsInWrapUp}</strong></div>
      <div><span>Leads prontos</span><strong>{realtime.leadsReady}</strong></div>
      <div><span>Leads aguardando horário</span><strong>{realtime.leadsWaiting}</strong></div>
      <div><span>Números conectados</span><strong>{realtime.numbersConnected}</strong></div>
      <div><span>Números em cooldown/quarentena</span><strong>{realtime.numbersInCooldown + realtime.numbersInQuarantine}</strong></div>
    </div>
  </Panel>;
}

function applyTargetAsFilter(target: DrilldownTarget, filters: MetricsFiltersState): MetricsFiltersState {
  const withUnique = (list: string[], value: string) => Array.from(new Set([...list, value]));
  if (target.kind === 'callResult') return { ...filters, callResults: withUnique(filters.callResults, target.code) };
  if (target.kind === 'pipelineStage') return { ...filters, pipelineStages: withUnique(filters.pipelineStages, target.code) };
  if (target.kind === 'sdr') return { ...filters, sdrIds: withUnique(filters.sdrIds, target.id) };
  if (target.kind === 'folder') return { ...filters, folderIds: withUnique(filters.folderIds, target.id) };
  if (target.kind === 'number') return { ...filters, numberIds: withUnique(filters.numberIds, target.id) };
  return filters;
}

export function MetricsPage({ tenantId, leadFolders, sdrs, numbers }: { tenantId: string; leadFolders: AnyRow[]; sdrs: AnyRow[]; numbers: AnyRow[] }) {
  const metrics = useMetrics(tenantId);
  const { summary } = metrics;
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null);

  const applyAsFilter = (target: DrilldownTarget) => { metrics.setFilters(applyTargetAsFilter(target, metrics.filters)); setDrilldown(null); };

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">ANÁLISE</span><h1>Métricas</h1><p>Acompanhamento histórico da operação comercial — chamadas, leads, SDRs, pastas e números.</p></div>
      <div className="metrics-heading-actions">
        {summary && <Badge tone={metrics.refreshing ? 'info' : 'neutral'}>{metrics.refreshing ? 'Atualizando…' : `${formatNumber(summary.kpis.callsMade.value)} chamadas no período`}</Badge>}
        <PdfExportControl params={metrics.query} />
      </div>
    </div>

    <MetricsFilters filters={metrics.filters} onChange={metrics.setFilters} leadFolders={leadFolders} sdrs={sdrs} numbers={numbers} />
    <SavedViewsPanel currentFilters={metrics.filters} onApply={metrics.setFilters} />

    {metrics.loading && !summary && <div className="admin-loading" role="status" aria-label="Carregando métricas"><span /><span /><span /></div>}

    {metrics.summaryError && <div className="alert" role="alert"><span>Não foi possível carregar o resumo: {metrics.summaryError}</span></div>}

    {summary && <>
      <RealtimeStrip realtime={summary.realtime} />
      <MetricsAlerts alerts={summary.alerts} />
      <div className="metrics-section-actions">
        <Button variant="secondary" onClick={() => setDrilldown({ kind: 'period', label: 'Chamadas do período' })}>Ver chamadas do período</Button>
      </div>
      <MetricsKpiGrid kpis={summary.kpis} />
      <ActivityTrendChart trends={summary.trends} granularity={summary.trendsGranularity} />
      <FunnelChart stages={summary.funnel} />
      <OutcomeBreakdown
        outcomes={summary.outcomes}
        pipeline={summary.pipeline}
        onSelectOutcome={(item) => setDrilldown({ kind: 'callResult', code: item.code, label: `Resultado: ${item.label}` })}
        onSelectStage={(item) => setDrilldown({ kind: 'pipelineStage', code: item.code, label: `Etapa: ${item.label}` })}
      />

      {metrics.rankingsError && <div className="alert" role="alert"><span>Não foi possível carregar as tabelas de desempenho: {metrics.rankingsError}</span></div>}
      <SdrPerformanceTable rows={metrics.sdrRanking ?? []} onSelect={(row) => setDrilldown({ kind: 'sdr', id: row.sdrId, label: `SDR: ${row.name}` })} exportParams={metrics.query} />
      <FolderPerformanceTable rows={metrics.folderRanking ?? []} onSelect={(row) => setDrilldown({ kind: 'folder', id: row.folderId, label: `Pasta: ${row.name}` })} exportParams={metrics.query} />
      <NumberHealthTable rows={metrics.numberRanking ?? []} onSelect={(row) => setDrilldown({ kind: 'number', id: row.numberId, label: `Número: ${row.label}` })} exportParams={metrics.query} />

      <MetricsGoals leadFolders={leadFolders} sdrs={sdrs} />

      <Panel>
        <details className="metrics-help">
          <summary>O que significa cada métrica?</summary>
          <dl className="metrics-help-list">
            {METRIC_DEFINITIONS.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.formula}</dd></div>)}
          </dl>
        </details>
      </Panel>

      <div className="metrics-footer" aria-live="polite">
        <span>Fonte: chamadas e leads da organização</span>
        <span>Fuso: {summary.period.timezone}</span>
        <span>{metrics.lastUpdatedAt ? `Atualizado às ${metrics.lastUpdatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}{metrics.refreshing ? ' · atualizando em segundo plano…' : ''}</span>
      </div>
    </>}

    {drilldown && <MetricDetailDrawer target={drilldown} baseParams={metrics.query} onClose={() => setDrilldown(null)} onApplyAsFilter={applyAsFilter} />}
  </>;
}
