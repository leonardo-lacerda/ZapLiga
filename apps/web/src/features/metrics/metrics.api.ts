import { apiFetch, json, refreshAccessToken } from '../../services/api';
import type { GoalMetric, GoalScope, GoalValueType, MetricGoal, MetricsCallDrilldownItem, MetricsExportJob, MetricsFolderRanking, MetricsNumberRanking, MetricsPage, MetricsSdrRanking, MetricsSummaryResponse, ReportPeriodPreset, SavedView } from './metrics.types';

export type MetricsQueryParams = {
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  folderIds?: string[];
  sdrIds?: string[];
  numberIds?: string[];
  source?: string;
  callResults?: string[];
  pipelineStages?: string[];
  statuses?: string[];
  limit?: string;
  offset?: string;
};

// O backend usa o parser de query padrão do Express (qs), que já entende
// chaves repetidas (`folderIds=a&folderIds=b`) como array — não precisa de
// `[]` no nome do campo.
function buildQuery(params: MetricsQueryParams): string {
  const usp = new URLSearchParams();
  const add = (key: string, value: string | string[] | undefined) => {
    if (value === undefined || value === '') return;
    if (Array.isArray(value)) { for (const item of value) if (item) usp.append(key, item); }
    else usp.append(key, value);
  };
  add('from', params.from);
  add('to', params.to);
  add('compareFrom', params.compareFrom);
  add('compareTo', params.compareTo);
  add('folderIds', params.folderIds);
  add('sdrIds', params.sdrIds);
  add('numberIds', params.numberIds);
  add('source', params.source);
  add('callResults', params.callResults);
  add('pipelineStages', params.pipelineStages);
  add('statuses', params.statuses);
  add('limit', params.limit);
  add('offset', params.offset);
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

export const fetchMetricsSummary = (params: MetricsQueryParams): Promise<MetricsSummaryResponse> => json(`/api/metrics/summary${buildQuery(params)}`);
export const fetchMetricsSdrRanking = (params: MetricsQueryParams): Promise<MetricsSdrRanking[]> => json(`/api/metrics/sdrs${buildQuery(params)}`);
export const fetchMetricsFolderRanking = (params: MetricsQueryParams): Promise<MetricsFolderRanking[]> => json(`/api/metrics/folders${buildQuery(params)}`);
export const fetchMetricsNumberRanking = (params: MetricsQueryParams): Promise<MetricsNumberRanking[]> => json(`/api/metrics/numbers${buildQuery(params)}`);
export const fetchMetricsCallsDrilldown = (params: MetricsQueryParams): Promise<MetricsPage<MetricsCallDrilldownItem>> => json(`/api/metrics/calls${buildQuery(params)}`);

export type GoalInput = { scope: GoalScope; scopeId?: string; metric: GoalMetric; valueType: GoalValueType; targetValue: number; periodFrom: string; periodTo: string };
export type GoalUpdateInput = { valueType?: GoalValueType; targetValue?: number; periodFrom?: string; periodTo?: string };

export const fetchMetricsGoals = (params: { status?: string } = {}): Promise<MetricGoal[]> => {
  const usp = new URLSearchParams();
  if (params.status) usp.set('status', params.status);
  const qs = usp.toString();
  return json(`/api/metrics/goals${qs ? `?${qs}` : ''}`);
};
export const createMetricsGoal = (input: GoalInput): Promise<MetricGoal> => json('/api/metrics/goals', { method: 'POST', body: JSON.stringify(input) });
export const updateMetricsGoal = (id: string, input: GoalUpdateInput): Promise<MetricGoal> => json(`/api/metrics/goals/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const deleteMetricsGoal = (id: string): Promise<{ ok: boolean; id: string }> => json(`/api/metrics/goals/${id}`, { method: 'DELETE' });

// `json()` só serve para respostas JSON — exportações devolvem CSV/PDF cru,
// então reaproveitamos a mesma lógica de retry em 401 (token expirado no
// meio de um export não deve simplesmente falhar) sem tentar fazer parse do
// corpo como JSON.
async function fetchWithAuthRetry(path: string, retry = true): Promise<Response> {
  const response = await apiFetch(path);
  if (response.status === 401 && retry) {
    if (await refreshAccessToken()) return fetchWithAuthRetry(path, false);
  }
  return response;
}

function parseFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  return match ? match[1] : fallback;
}

async function triggerBlobDownload(response: Response, fallbackFileName: string) {
  const blob = await response.blob();
  const fileName = parseFileName(response, fallbackFileName);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = fileName;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  URL.revokeObjectURL(url);
}

async function throwIfError(response: Response, fallbackMessage: string) {
  if (response.ok || response.status === 202) return;
  const body = await response.json().catch(() => ({}));
  throw new Error(body.message ?? fallbackMessage);
}

export type CsvExportResult = { async: false } | { async: true; exportId: string };

export const downloadMetricsCsv = async (dataset: string, params: MetricsQueryParams): Promise<CsvExportResult> => {
  // `buildQuery` só serializa os campos que conhece explicitamente — `dataset`
  // não é um deles, então entra à parte via URLSearchParams direto.
  const usp = new URLSearchParams(buildQuery(params).slice(1));
  usp.set('dataset', dataset);
  const response = await fetchWithAuthRetry(`/api/metrics/export.csv?${usp.toString()}`);
  await throwIfError(response, 'Não foi possível exportar');
  if (response.status === 202) { const body = await response.json(); return { async: true, exportId: body.exportId }; }
  await triggerBlobDownload(response, `${dataset}.csv`);
  return { async: false };
};

export const downloadMetricsPdf = async (params: MetricsQueryParams, period: ReportPeriodPreset): Promise<void> => {
  const usp = new URLSearchParams(buildQuery(params).slice(1));
  if (period !== 'custom') usp.set('period', period);
  const response = await fetchWithAuthRetry(`/api/metrics/export.pdf?${usp.toString()}`);
  await throwIfError(response, 'Não foi possível gerar o PDF');
  await triggerBlobDownload(response, 'relatorio-metricas.pdf');
};

export const checkMetricsExportStatus = (exportId: string): Promise<MetricsExportJob> => json(`/api/metrics/exports/${exportId}`);

export const downloadCompletedMetricsExport = async (exportId: string): Promise<void> => {
  const response = await fetchWithAuthRetry(`/api/metrics/exports/${exportId}/download`);
  await throwIfError(response, 'Não foi possível baixar a exportação');
  await triggerBlobDownload(response, `export-${exportId}.csv`);
};

export type SavedViewInput = { name: string; isShared?: boolean; filters: Record<string, unknown> };
export type SavedViewUpdateInput = { name?: string; isShared?: boolean; filters?: Record<string, unknown> };

export const fetchMetricsViews = (): Promise<SavedView[]> => json('/api/metrics/views');
export const createMetricsView = (input: SavedViewInput): Promise<SavedView> => json('/api/metrics/views', { method: 'POST', body: JSON.stringify(input) });
export const updateMetricsView = (id: string, input: SavedViewUpdateInput): Promise<SavedView> => json(`/api/metrics/views/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
export const deleteMetricsView = (id: string): Promise<{ ok: boolean; id: string }> => json(`/api/metrics/views/${id}`, { method: 'DELETE' });
