import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMetricsFolderRanking, fetchMetricsNumberRanking, fetchMetricsSdrRanking, fetchMetricsSummary, MetricsQueryParams } from './metrics.api';
import type { MetricsFolderRanking, MetricsNumberRanking, MetricsSdrRanking, MetricsSource, MetricsSummaryResponse } from './metrics.types';

const REFRESH_INTERVAL_MS = 30_000;

export type MetricsRankingKey = 'sdrs' | 'folders' | 'numbers';

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
  const [rankingsLoading, setRankingsLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const query = useMemo(() => toQueryParams(filters), [filters]);
  const queryKey = JSON.stringify(query);
  const hasLoadedOnce = useRef(false);
  const loadedRankingKeys = useRef(new Set<string>());
  const currentQueryKey = useRef(queryKey);
  const summaryRequestId = useRef(0);
  const rankingRequestId = useRef(0);
  currentQueryKey.current = queryKey;

  const loadSummary = useCallback(async (background: boolean) => {
    if (!tenantId) return;
    const requestId = ++summaryRequestId.current;
    if (background) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetchMetricsSummary(query);
      if (currentQueryKey.current === queryKey && requestId === summaryRequestId.current) {
        setSummary(result);
        setSummaryError('');
        setLastUpdatedAt(new Date());
      }
    } catch (reason) {
      if (currentQueryKey.current === queryKey && requestId === summaryRequestId.current) setSummaryError(errorMessage(reason));
    } finally {
      if (requestId === summaryRequestId.current) {
        if (background) setRefreshing(false); else setLoading(false);
        hasLoadedOnce.current = true;
      }
    }
  }, [tenantId, query, queryKey]);

  const loadRanking = useCallback(async (key: MetricsRankingKey) => {
    if (!tenantId) return;
    const requestKey = `${queryKey}:${key}`;
    if (loadedRankingKeys.current.has(requestKey)) return;

    const requestId = ++rankingRequestId.current;
    setRankingsLoading(true);
    setRankingsError('');
    try {
      if (key === 'sdrs') {
        const result = await fetchMetricsSdrRanking(query);
        if (currentQueryKey.current === queryKey && requestId === rankingRequestId.current) setSdrRanking(result);
      }
      if (key === 'folders') {
        const result = await fetchMetricsFolderRanking(query);
        if (currentQueryKey.current === queryKey && requestId === rankingRequestId.current) setFolderRanking(result);
      }
      if (key === 'numbers') {
        const result = await fetchMetricsNumberRanking(query);
        if (currentQueryKey.current === queryKey && requestId === rankingRequestId.current) setNumberRanking(result);
      }
      if (currentQueryKey.current === queryKey && requestId === rankingRequestId.current) {
        loadedRankingKeys.current.add(requestKey);
      }
    } catch (reason) {
      if (currentQueryKey.current === queryKey && requestId === rankingRequestId.current) setRankingsError(errorMessage(reason));
    } finally {
      if (requestId === rankingRequestId.current) setRankingsLoading(false);
    }
  }, [tenantId, query, queryKey]);

  useEffect(() => {
    rankingRequestId.current += 1;
    loadedRankingKeys.current.clear();
    setSdrRanking(null);
    setFolderRanking(null);
    setNumberRanking(null);
    setRankingsError('');
    void loadSummary(hasLoadedOnce.current);
  }, [tenantId, queryKey, loadSummary]);

  useEffect(() => {
    const interval = window.setInterval(() => { void loadSummary(true); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadSummary]);

  return {
    filters, setFilters, query, queryKey,
    summary, sdrRanking, folderRanking, numberRanking,
    loading, refreshing, summaryError, rankingsError, rankingsLoading, lastUpdatedAt,
    loadRanking,
    reload: () => void loadSummary(false),
  };
}
