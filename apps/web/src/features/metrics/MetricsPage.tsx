import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
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
import { MetricsKpiGrid, SECONDARY_KPI_KEYS } from './MetricsKpiGrid';
import { NumberHealthTable } from './NumberHealthTable';
import { OutcomeBreakdown } from './OutcomeBreakdown';
import { SavedViewsPanel } from './SavedViewsPanel';
import { SdrPerformanceTable } from './SdrPerformanceTable';
import type { MetricsRankingKey } from './useMetrics';
import { MetricsFiltersState, useMetrics } from './useMetrics';
import type { ReportPeriodPreset } from './metrics.types';

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

function RealtimeStrip({ realtime, expanded, onToggle }: { realtime: NonNullable<ReturnType<typeof useMetrics>['summary']>['realtime']; expanded: boolean; onToggle: () => void }) {
  const visibleItems = expanded ? [
    ['Chamadas ativas', realtime.activeCalls], ['SDRs disponíveis', realtime.sdrsAvailable], ['SDRs em chamada', realtime.sdrsInCall],
    ['SDRs em pós-atendimento', realtime.sdrsInWrapUp], ['Leads prontos', realtime.leadsReady], ['Leads aguardando horário', realtime.leadsWaiting],
    ['Números conectados', realtime.numbersConnected], ['Números em cooldown/quarentena', realtime.numbersInCooldown + realtime.numbersInQuarantine],
  ] : [['Chamadas ativas', realtime.activeCalls], ['SDRs disponíveis', realtime.sdrsAvailable], ['Leads prontos', realtime.leadsReady]];

  return <Panel className="metrics-realtime-panel">
    <SectionHeader eyebrow="TEMPO REAL" title="Operação agora" description="Um resumo do estado atual, separado da análise histórica." action={realtime.queueStalled ? <Badge tone="warning">Fila parada</Badge> : undefined} />
    <div className={`folder-metric-grid metrics-realtime-grid${expanded ? ' is-expanded' : ''}`}>
      {visibleItems.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
    <button type="button" className="metrics-inline-disclosure" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Mostrar resumo' : 'Ver detalhes da operação'}</button>
  </Panel>;
}

function ProgressiveSection({ id, eyebrow, title, description, open, onToggle, children }: { id: string; eyebrow: string; title: string; description: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return <section className={`metrics-progressive-section${open ? ' is-open' : ''}`}>
    <button type="button" className="metrics-progressive-trigger" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <span><small>{eyebrow}</small><strong>{title}</strong><em>{description}</em></span>
      <span className="metrics-progressive-trigger-icon" aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <div id={id} className="metrics-progressive-content">{children}</div>}
  </section>;
}

const RANKING_TABS: { key: MetricsRankingKey; label: string; description: string }[] = [
  { key: 'sdrs', label: 'Equipe', description: 'Compare a produtividade e o registro de cada SDR.' },
  { key: 'folders', label: 'Pastas', description: 'Identifique filas e pastas com maior avanço.' },
  { key: 'numbers', label: 'Números', description: 'Acompanhe disponibilidade e falhas técnicas.' },
];

function RankingsSection({ metrics, tab, onTabChange, onSelect }: { metrics: ReturnType<typeof useMetrics>; tab: MetricsRankingKey; onTabChange: (tab: MetricsRankingKey) => void; onSelect: (target: DrilldownTarget) => void }) {
  const selectedTab = RANKING_TABS.find((item) => item.key === tab) ?? RANKING_TABS[0];
  const rows = tab === 'sdrs' ? metrics.sdrRanking : tab === 'folders' ? metrics.folderRanking : metrics.numberRanking;

  return <div className="metrics-rankings">
    <div className="metrics-tabs" role="tablist" aria-label="Dimensão de desempenho">
      {RANKING_TABS.map((item) => <button type="button" role="tab" key={item.key} aria-selected={tab === item.key} className={tab === item.key ? 'is-active' : ''} onClick={() => onTabChange(item.key)}>{item.label}</button>)}
    </div>
    <div className="metrics-tab-heading"><div><strong>{selectedTab.label}</strong><span>{selectedTab.description}</span></div><Badge>{rows?.length ?? 0} carregados</Badge></div>
    {metrics.rankingsLoading && !rows && <SectionLoading label={`Carregando ${selectedTab.label.toLowerCase()}…`} />}
    {metrics.rankingsError && <div className="alert" role="alert"><span>Não foi possível carregar esta tabela: {metrics.rankingsError}</span><Button variant="ghost" onClick={() => void metrics.loadRanking(tab)}>Tentar novamente</Button></div>}
    {!metrics.rankingsLoading && !metrics.rankingsError && tab === 'sdrs' && <SdrPerformanceTable rows={metrics.sdrRanking ?? []} onSelect={(row) => onSelect({ kind: 'sdr', id: row.sdrId, label: `SDR: ${row.name}` })} exportParams={metrics.query} />}
    {!metrics.rankingsLoading && !metrics.rankingsError && tab === 'folders' && <FolderPerformanceTable rows={metrics.folderRanking ?? []} onSelect={(row) => onSelect({ kind: 'folder', id: row.folderId, label: `Pasta: ${row.name}` })} exportParams={metrics.query} />}
    {!metrics.rankingsLoading && !metrics.rankingsError && tab === 'numbers' && <NumberHealthTable rows={metrics.numberRanking ?? []} onSelect={(row) => onSelect({ kind: 'number', id: row.numberId, label: `Número: ${row.label}` })} exportParams={metrics.query} />}
  </div>;
}

function SectionLoading({ label }: { label: string }) {
  return <Panel className="metrics-section-loading"><div className="admin-loading" role="status" aria-label={label}><span /><span /><span /></div><small>{label}</small></Panel>;
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
  const [realtimeExpanded, setRealtimeExpanded] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [performanceTab, setPerformanceTab] = useState<MetricsRankingKey>('sdrs');

  useEffect(() => {
    if (performanceOpen) void metrics.loadRanking(performanceTab);
  }, [performanceOpen, performanceTab, metrics.queryKey, metrics.loadRanking]);

  const selectDrilldown = (target: DrilldownTarget) => setDrilldown(target);
  const applyAsFilter = (target: DrilldownTarget) => { metrics.setFilters(applyTargetAsFilter(target, metrics.filters)); setDrilldown(null); };

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">ANÁLISE</span><h1>Métricas</h1><p>Comece pelo resumo e aprofunde apenas onde precisar.</p></div>
      <div className="metrics-heading-actions">
        {summary && <Badge tone={metrics.refreshing ? 'info' : 'neutral'}>{metrics.refreshing ? 'Atualizando…' : `${formatNumber(summary.kpis.callsMade.value)} chamadas no período`}</Badge>}
        <PdfExportControl params={metrics.query} />
      </div>
    </div>

    <MetricsFilters filters={metrics.filters} onChange={metrics.setFilters} leadFolders={leadFolders} sdrs={sdrs} numbers={numbers} />

    {metrics.loading && !summary && <div className="admin-loading" role="status" aria-label="Carregando métricas"><span /><span /><span /></div>}
    {metrics.summaryError && <div className="alert" role="alert"><span>Não foi possível carregar o resumo: {metrics.summaryError}</span><Button variant="ghost" onClick={metrics.reload}>Tentar novamente</Button></div>}

    {summary && <>
      <MetricsKpiGrid kpis={summary.kpis} />
      <details className="metrics-secondary-kpis">
        <summary>Ver mais indicadores</summary>
        <MetricsKpiGrid kpis={summary.kpis} keys={SECONDARY_KPI_KEYS} />
      </details>

      <MetricsAlerts alerts={summary.alerts} />
      <RealtimeStrip realtime={summary.realtime} expanded={realtimeExpanded} onToggle={() => setRealtimeExpanded((current) => !current)} />

      <ProgressiveSection id="metrics-analysis" eyebrow="ANÁLISE" title="Entender o desempenho" description="Evolução, funil e distribuição dos resultados." open={analysisOpen} onToggle={() => setAnalysisOpen((current) => !current)}>
        <ActivityTrendChart trends={summary.trends} granularity={summary.trendsGranularity} />
        <FunnelChart stages={summary.funnel} />
        <OutcomeBreakdown
          outcomes={summary.outcomes}
          pipeline={summary.pipeline}
          onSelectOutcome={(item) => selectDrilldown({ kind: 'callResult', code: item.code, label: `Resultado: ${item.label}` })}
          onSelectStage={(item) => selectDrilldown({ kind: 'pipelineStage', code: item.code, label: `Etapa: ${item.label}` })}
        />
      </ProgressiveSection>

      <ProgressiveSection id="metrics-performance" eyebrow="DESEMPENHO" title="Comparar equipe, pastas e números" description="Escolha uma dimensão para carregar sua tabela detalhada." open={performanceOpen} onToggle={() => setPerformanceOpen((current) => !current)}>
        <div className="metrics-section-actions"><Button variant="secondary" onClick={() => setDrilldown({ kind: 'period', label: 'Chamadas do período' })}>Ver chamadas do período</Button></div>
        <RankingsSection metrics={metrics} tab={performanceTab} onTabChange={setPerformanceTab} onSelect={selectDrilldown} />
      </ProgressiveSection>

      <ProgressiveSection id="metrics-management" eyebrow="GESTÃO" title="Metas, filtros salvos e definições" description="Recursos de acompanhamento e configuração para a liderança." open={managementOpen} onToggle={() => setManagementOpen((current) => !current)}>
        <SavedViewsPanel currentFilters={metrics.filters} onApply={metrics.setFilters} />
        <MetricsGoals leadFolders={leadFolders} sdrs={sdrs} />
        <Panel>
          <details className="metrics-help">
            <summary>O que significa cada métrica?</summary>
            <dl className="metrics-help-list">
              {METRIC_DEFINITIONS.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.formula}</dd></div>)}
            </dl>
          </details>
        </Panel>
      </ProgressiveSection>

      <div className="metrics-footer" aria-live="polite">
        <span>Fonte: chamadas e leads da organização</span>
        <span>Fuso: {summary.period.timezone}</span>
        <span>{metrics.lastUpdatedAt ? `Atualizado às ${metrics.lastUpdatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}{metrics.refreshing ? ' · atualizando em segundo plano…' : ''}</span>
      </div>
    </>}

    {drilldown && <MetricDetailDrawer target={drilldown} baseParams={metrics.query} onClose={() => setDrilldown(null)} onApplyAsFilter={applyAsFilter} />}
  </>;
}
