// Catálogo comercial e regras de interpretação da área de Métricas.
// Fonte única de verdade para `call_result` e `pipeline_stage` (hoje texto livre
// no banco — ver apps/api/src/database/migrations/000_initial_domain_schema.sql).
// O frontend (apps/web/src/features/calls/PostCallPanel.tsx) deve consumir estes
// mesmos códigos/rótulos em vez de manter sua própria cópia.

export type CallResultClassification = 'positive' | 'neutral' | 'negative' | 'conversion';

export type CallResultCode = 'interessado' | 'reuniao_agendada' | 'retornar' | 'sem_interesse' | 'numero_invalido';

export const CALL_RESULT_CATALOG: Record<CallResultCode, { label: string; classification: CallResultClassification }> = {
  reuniao_agendada: { label: 'Reunião agendada', classification: 'conversion' },
  interessado: { label: 'Interessado', classification: 'positive' },
  retornar: { label: 'Solicitou retorno', classification: 'neutral' },
  sem_interesse: { label: 'Sem interesse', classification: 'negative' },
  numero_invalido: { label: 'Número inválido', classification: 'negative' },
};

// Código sintético para chamadas sem call_result/pipeline_stage (coluna NULL
// no banco). Usado tanto para rotular o agrupamento "sem resultado"/"sem
// etapa" nas distribuições quanto para permitir que o mesmo código, quando
// vem de volta como filtro (clique no drilldown → "aplicar como filtro"),
// vire `IS NULL` em vez de um `= ANY(...)` que nunca bateria com nada.
export const NO_RESULT_CODE = 'sem_resultado';
export const NO_STAGE_CODE = 'sem_etapa';

export type PipelineStageCode = 'novo' | 'contatado' | 'qualificado' | 'reuniao' | 'ganho' | 'perdido';

export const PIPELINE_STAGE_CATALOG: Record<PipelineStageCode, { label: string; order: number; isConversion: boolean }> = {
  novo: { label: 'Novo', order: 0, isConversion: false },
  contatado: { label: 'Contatado', order: 1, isConversion: false },
  qualificado: { label: 'Qualificado', order: 2, isConversion: false },
  reuniao: { label: 'Reunião', order: 3, isConversion: false },
  ganho: { label: 'Ganho', order: 4, isConversion: true },
  perdido: { label: 'Perdido', order: 5, isConversion: false },
};

export const isKnownCallResult = (code: string | null | undefined): code is CallResultCode =>
  code != null && Object.prototype.hasOwnProperty.call(CALL_RESULT_CATALOG, code);

export const isKnownPipelineStage = (code: string | null | undefined): code is PipelineStageCode =>
  code != null && Object.prototype.hasOwnProperty.call(PIPELINE_STAGE_CATALOG, code);

// "Resultado positivo" (plano seção 4) inclui conversões — uma reunião agendada
// é, por definição, um resultado positivo, além de ser também uma conversão.
export const POSITIVE_CALL_RESULT_CODES: CallResultCode[] = (Object.keys(CALL_RESULT_CATALOG) as CallResultCode[])
  .filter((code) => CALL_RESULT_CATALOG[code].classification === 'positive' || CALL_RESULT_CATALOG[code].classification === 'conversion');

export const CONVERSION_CALL_RESULT_CODES: CallResultCode[] = (Object.keys(CALL_RESULT_CATALOG) as CallResultCode[])
  .filter((code) => CALL_RESULT_CATALOG[code].classification === 'conversion');

export const CONVERSION_PIPELINE_STAGE_CODES: PipelineStageCode[] = (Object.keys(PIPELINE_STAGE_CATALOG) as PipelineStageCode[])
  .filter((code) => PIPELINE_STAGE_CATALOG[code].isConversion);

// `tenants.timezone` (migration 019) guarda o fuso real de cada organização;
// este valor é só o fallback para o cenário em que nem o tenant nem a query
// informam um timezone.
export const DEFAULT_TENANT_TIMEZONE = 'America/Sao_Paulo';

export const ACTIVE_CALL_STATUSES = ['reserved', 'dialing', 'media_active'] as const;
export const CONNECTED_NUMBER_STATUSES = ['connected', 'online', 'ready', 'authenticated'] as const;

// Mapeamento de eventos existentes -> ocorrência que cada um representa
// (plano seção 4, coluna "Definição").
export const METRICS_EVENT_MAP = {
  'calls.created_at': 'Chamada registrada (tentativa realizada, automática ou manual)',
  'calls.connected_at': 'Chamada atendida pelo lead',
  'calls.ended_at': 'Chamada encerrada (qualquer desfecho)',
  'calls.duration_seconds': 'Duração total da chamada (toque + conexão) — mantido por compatibilidade',
  'calls.ring_duration_seconds': 'Duração do toque, do início da discagem até atender ou desistir (migration 018)',
  'calls.connected_duration_seconds': 'Duração da conversa, da conexão até o encerramento (migration 018)',
  'calls.wrap_up_completed_at': 'SDR concluiu o pós-atendimento (registro de resultado/etapa)',
  'calls.call_result': 'Resultado comercial declarado no pós-atendimento',
  'calls.pipeline_stage': 'Etapa do funil no momento desta chamada',
  'calls.source': "Origem da tentativa: 'automatico' ou 'manual'",
  'leads.pipeline_stage': 'Etapa atual do lead — o histórico de transições vive em lead_stage_history (migration 016)',
  'leads.status': "Estado operacional na fila: 'queued' | 'retry_wait' | 'reserved' | 'dialing' | 'media_active' | 'completed'",
  'sdrs.state': "Estado do SDR: 'available' | 'in_call' | 'post_call' | 'offline' — histórico em sdr_availability_history (migration 017)",
  'whatsapp_numbers.status': 'Estado de conexão do número — histórico em number_status_history (migration 017)',
} as const;

// Metas (plano seção 6.7) — os 7 tipos de meta que a organização pode
// configurar. `unit` orienta a formatação (contagem simples, segundos ou
// percentual) e qual `value_type` faz sentido por padrão para essa métrica.
export type GoalMetric = 'calls_made' | 'leads_worked' | 'answer_rate' | 'positive_results' | 'stage_advances' | 'conversions' | 'connected_seconds';
export type GoalScope = 'organization' | 'sdr' | 'folder';
export type GoalValueType = 'absolute' | 'percentage';

export const GOAL_METRIC_CATALOG: Record<GoalMetric, { label: string; unit: 'count' | 'seconds' | 'percent' }> = {
  calls_made: { label: 'Chamadas realizadas', unit: 'count' },
  leads_worked: { label: 'Leads trabalhados', unit: 'count' },
  answer_rate: { label: 'Taxa de atendimento', unit: 'percent' },
  positive_results: { label: 'Resultados positivos', unit: 'count' },
  stage_advances: { label: 'Avanço de etapa', unit: 'count' },
  conversions: { label: 'Conversão', unit: 'count' },
  connected_seconds: { label: 'Tempo conectado', unit: 'seconds' },
};

export const GOAL_SCOPES: GoalScope[] = ['organization', 'sdr', 'folder'];
