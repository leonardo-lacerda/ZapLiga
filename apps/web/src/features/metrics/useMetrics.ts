import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetricsFolderRanking, fetchMetricsNumberRanking, fetchMetricsSdrRanking, fetchMetricsSummary, MetricsQueryParams } from './metrics.api';
import type { MetricsFolderRanking, MetricsNumberRanking, MetricsSdrRanking, MetricsSource, MetricsSummaryResponse } from './metrics.types';

const REFRESH_INTERVAL_MS = 30_000;

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export type MetricsFiltersState = {
  from: string;
  to: string;
  useCustomCompare: boolean;
  compareFrom: string;
  compareTo: string;
  folderIds: string[];
  sdrIds: string[];
  numberIds: string[];
  source: MetricsSource;
  callResults: string[];
  pipelineStages: string[];
  statuses: string[];
};

export function defaultMetricsFilters(): MetricsFiltersState {
  const to = isoDate(new Date());
  const from = isoDate(new Date(Date.now() - 6 * 86_400_000));
  return { from, to, useCustomCompare: false, compareFrom: '', compareTo: '', folderIds: [], sdrIds: [], numberIds: [], source: 'all', callResults: [], pipelineStages: [], statuses: [] };
}

export function activeFilterCount(filters: MetricsFiltersState): number {
  let count = 0;
  if (filters.folderIds.length) count++;
  if (filters.sdrIds.length) count++;
  if (filters.numberIds.length) count++;
  if (filters.source !== 'all') count++;
  if (filters.callResults.length) count++;
  if (filters.pipelineStages.length) count++;
  if (filters.statuses.length) count++;
  if (filters.useCustomCompare) count++;
  return count;
}

export function toQueryParams(filters: MetricsFiltersState): MetricsQueryParams {
  return {
    from: filters.from,
    to: filters.to,
    compareFrom: filters.useCustomCompare ? filters.compareFrom || undefined : undefined,
    compareTo: filters.useCustomCompare ? filters.compareTo || undefined : undefined,
    folderIds: filters.folderIds.length ? filters.folderIds : undefined,
    sdrIds: filters.sdrIds.length ? filters.sdrIds : undefined,
    numberIds: filters.numberIds.length ? filters.numberIds : undefined,
    source: filters.source !== 'all' ? filters.source : undefined,
    callResults: filters.callResults.length ? filters.callResults : undefined,
    pipelineStages: filters.pipelineStages.length ? filters.pipelineStages : undefined,
    statuses: filters.statuses.length ? filters.statuses : undefined,
  };
}

const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/**
 * Estado da página de Métricas (plano seção 9.1). Fica fora do `load()`
 * central do App.tsx de propósito: métricas tem seu próprio período/filtros
 * e não deve ser buscada em todo poll do Dashboard (plano seção 10: "lazy
 * loading de abas secundárias").
 */
export function useMetrics(tenantId: string) {
  const [filters, setFilters] = useState<MetricsFiltersState>(defaultMetricsFilters);
  const [summary, setSummary] = useState<MetricsSummaryResponse | null>(null);
  const [sdrRanking, setSdrRanking] = useState<MetricsSdrRanking[] | null>(null);
  const [folderRanking, setFolderRanking] = useState<MetricsFolderRanking[] | null>(null);
  const [numberRanking, setNumberRanking] = useState<MetricsNumberRanking[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [rankingsError, setRankingsError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const query = useMemo(() => toQueryParams(filters), [filters]);
  const queryKey = JSON.stringify(query);
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async (background: boolean) => {
    if (!tenantId) return;
    if (background) setRefreshing(true); else setLoading(true);
    const [summaryResult, sdrResult, folderResult, numberResult] = await Promise.allSettled([
      fetchMetricsSummary(query),
      fetchMetricsSdrRanking(query),
      fetchMetricsFolderRanking(query),
      fetchMetricsNumberRanking(query),
    ]);
    if (summaryResult.status === 'fulfilled') { setSummary(summaryResult.value); setSummaryError(''); }
    else setSummaryError(errorMessage(summaryResult.reason));
    if (sdrResult.status === 'fulfilled') setSdrRanking(sdrResult.value);
    if (folderResult.status === 'fulfilled') setFolderRanking(folderResult.value);
    if (numberResult.status === 'fulfilled') setNumberRanking(numberResult.value);
    const rankingFailure = [sdrResult, folderResult, numberResult].find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
    setRankingsError(rankingFailure ? errorMessage(rankingFailure.reason) : '');
    setLastUpdatedAt(new Date());
    if (background) setRefreshing(false); else setLoading(false);
    hasLoadedOnce.current = true;
  }, [tenantId, query]);

  useEffect(() => { void load(hasLoadedOnce.current); }, [tenantId, queryKey, load]);

  useEffect(() => {
    const interval = window.setInterval(() => { void load(true); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return {
    filters, setFilters, query,
    summary, sdrRanking, folderRanking, numberRanking,
    loading, refreshing, summaryError, rankingsError, lastUpdatedAt,
    reload: () => void load(false),
  };
}
