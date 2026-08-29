// Espelho de apps/api/src/modules/metrics/metrics.types.ts (contrato dos
// endpoints GET /api/metrics/* — plano seção 7). A página em si (filtros,
// cards, gráficos) é construída na Fase 4; por ora só o contrato de dados.

export type MetricsSource = 'automatico' | 'manual' | 'all';

export type MetricsPeriod = { from: string; to: string; timezone: string };

export type MetricsComparison = { from: string | null; to: string | null; available: boolean };

export type MetricsFreshness = { generatedAt: string; dataThrough: string; delayed: boolean };

export type MetricsFilters = {
  folderIds: string[];
  sdrIds: string[];
  numberIds: string[];
  source: MetricsSource;
  callResults: string[];
  pipelineStages: string[];
  statuses: string[];
};

export type MetricValue = {
  value: number;
  previousValue: number | null;
  changeAbsolute: number | null;
  changePercent: number | null;
  numerator?: number;
  denominator?: number;
};

export type MetricsKpis = {
  callsMade: MetricValue;
  uniqueLeadsWorked: MetricValue;
  callsAnswered: MetricValue;
  answerRate: MetricValue;
  connectedSeconds: MetricValue;
  avgDurationSeconds: MetricValue;
  positiveResults: MetricValue;
  wrapUpRate: MetricValue;
  activeSdrs: MetricValue;
  leadsInQueue: MetricValue;
};

export type MetricsTrendGranularity = 'hour' | 'day' | 'week';
export type MetricsTrendPoint = { bucket: string; callsMade: number; callsAnswered: number; answerRate: number; uniqueLeadsWorked: number; positiveResults: number; connectedSeconds: number };

/** `rule` explica a regra de contagem da etapa (plano seção 6.3). */
export type MetricsFunnelStage = { stage: string; label: string; count: number; rule: string };
export type MetricsBreakdownItem = { code: string; label: string; count: number; percent: number };

export type MetricsHeatmapMetric = 'volume' | 'answerRate' | 'positiveRate' | 'failureRate';
export type MetricsHeatmapCell = { dayOfWeek: number; hour: number; calls: number; answered: number; positiveResults: number; failed: number; answerRate: number; positiveRate: number; failureRate: number };

export type MetricsSdrRanking = {
  sdrId: string;
  name: string;
  status: string;
  available: boolean;
  callsMade: number;
  uniqueLeadsWorked: number;
  callsAnswered: number;
  answerRate: number;
  connectedSeconds: number;
  avgDurationSeconds: number;
  positiveResults: number;
  stageAdvances: number;
  wrapUpsCompleted: number;
  wrapUpRate: number;
};

export type MetricsFolderRanking = {
  folderId: string;
  name: string;
  isActive: boolean;
  totalLeads: number;
  leadsWorked: number;
  currentQueue: number;
  callsMade: number;
  callsAnswered: number;
  answerRate: number;
  positiveResults: number;
  stageAdvances: number;
  conversions: number;
  bestHour: number | null;
};

export type MetricsNumberRanking = {
  numberId: string;
  label: string;
  status: string;
  callsMade: number;
  callsAnswered: number;
  answerRate: number;
  failed: number;
  activeCalls: number;
  maxConcurrentCalls: number;
  utilization: number;
  cooldownRemainingSeconds: number;
  quarantineRemainingSeconds: number;
  lastActivityAt: string | null;
};

export type MetricsCallDrilldownItem = {
  callId: string;
  status: string;
  outcome: string | null;
  failureReason: string | null;
  callResult: string | null;
  pipelineStage: string | null;
  source: MetricsSource;
  attemptNumber: number;
  createdAt: string;
  startedAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  ringDurationSeconds: number | null;
  connectedDurationSeconds: number | null;
  wrapUpCompletedAt: string | null;
  notes: string | null;
  leadId: string;
  leadName: string;
  leadPhone: string;
  folderId: string;
  folderName: string;
  sdrId: string;
  sdrName: string;
  numberId: string;
  numberLabel: string;
};

export type MetricsLeadDrilldownItem = {
  leadId: string;
  name: string;
  phone: string;
  status: string;
  pipelineStage: string;
  attempts: number;
  doNotCall: boolean;
  nextEligibleAt: string;
  createdAt: string;
  folderId: string;
  folderName: string;
};

export type MetricsPage<T> = { items: T[]; total: number; limit: number; offset: number };

// Preenchidos na Fase 5 (alertas e insights).
export type MetricsAlertSeverity = 'info' | 'warning' | 'critical';
export type MetricsAlert = { id: string; severity: MetricsAlertSeverity; code: string; title: string; evidence: string; recommendedAction: string };

export type MetricsRealtime = {
  asOf: string;
  activeCalls: number;
  sdrsAvailable: number;
  sdrsInCall: number;
  sdrsInWrapUp: number;
  sdrsOffline: number;
  leadsReady: number;
  leadsWaiting: number;
  numbersConnected: number;
  numbersUnavailable: number;
  numbersInCooldown: number;
  numbersInQuarantine: number;
  queueStalled: boolean;
};

export type MetricsSummaryResponse = {
  period: MetricsPeriod;
  comparison: MetricsComparison;
  freshness: MetricsFreshness;
  filters: MetricsFilters;
  kpis: MetricsKpis;
  trends: MetricsTrendPoint[];
  trendsGranularity: MetricsTrendGranularity;
  funnel: MetricsFunnelStage[];
  outcomes: MetricsBreakdownItem[];
  pipeline: MetricsBreakdownItem[];
  alerts: MetricsAlert[];
  realtime: MetricsRealtime;
};

// Metas (plano seção 6.7) — espelho de apps/api/src/modules/metrics/{metrics.definitions,metrics-goals.progress,metrics-goals.service}.ts
export type GoalScope = 'organization' | 'sdr' | 'folder';
export type GoalMetric = 'calls_made' | 'leads_worked' | 'answer_rate' | 'positive_results' | 'stage_advances' | 'conversions' | 'connected_seconds';
export type GoalValueType = 'absolute' | 'percentage';
export type GoalStatus = 'active' | 'frozen' | 'archived';
export type GoalTrend = 'ahead' | 'on_track' | 'behind' | 'not_started';

export type GoalProgress = {
  actual: number;
  progressPercent: number;
  expectedPace: number;
  projectedFinal: number;
  difference: number;
  trend: GoalTrend;
  periodEnded: boolean;
};

export type MetricGoal = {
  id: string;
  scope: GoalScope;
  scopeId: string | null;
  scopeName: string | null;
  metric: GoalMetric;
  metricLabel: string;
  valueType: GoalValueType;
  targetValue: number;
  periodFrom: string;
  periodTo: string;
  status: GoalStatus;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
  supersededBy: string | null;
  progress: GoalProgress;
};

// Exportação e visualizações salvas (plano seção 6.8).
export type ExportJobStatus = 'processing' | 'completed' | 'failed';
export type MetricsExportJob = {
  id: string;
  status: ExportJobStatus;
  dataset: string;
  format: 'csv' | 'pdf';
  rowCount: number | null;
  fileName: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ReportPeriodPreset = 'custom' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export type SavedView = {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  ownerUserId: string;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};
