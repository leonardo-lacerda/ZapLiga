// Contrato de resposta de GET /api/metrics/summary (plano seção 7.1).
// Espelhado no frontend em apps/web/src/features/metrics/metrics.types.ts —
// qualquer mudança aqui deve ser replicada lá.

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

/** Todo percentual/valor exibido em card deve trazer variação e, quando aplicável, o denominador de origem (plano seção 6.2). */
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

/** `rule` explica a regra de contagem da etapa (plano seção 6.3: "o funil deve informar a regra de contagem"). */
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

// Metas (plano seção 6.7). Definições canônicas em metrics.definitions.ts
// (GoalMetric/GoalScope/GoalValueType), metrics-goals.progress.ts (GoalTrend)
// e metrics-goals.service.ts (GoalResponse) — reexportadas aqui só para
// manter este arquivo como o ponto único de contrato consultável.
export type { GoalMetric, GoalScope, GoalValueType } from './metrics.definitions';
export type { GoalProgress, GoalTrend } from './metrics-goals.progress';
export type { GoalResponse as MetricGoal } from './metrics-goals.service';
