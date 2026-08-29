// Espelho de apps/api/src/modules/metrics/metrics.definitions.ts — mesmos
// códigos usados em apps/web/src/features/calls/PostCallPanel.tsx. Usado
// para rotular filtros e distribuições sem repetir strings soltas.

export const CALL_RESULT_OPTIONS: [string, string][] = [
  ['reuniao_agendada', 'Reunião agendada'],
  ['interessado', 'Interessado'],
  ['retornar', 'Solicitou retorno'],
  ['sem_interesse', 'Sem interesse'],
  ['numero_invalido', 'Número inválido'],
];

export const PIPELINE_STAGE_OPTIONS: [string, string][] = [
  ['novo', 'Novo'],
  ['contatado', 'Contatado'],
  ['qualificado', 'Qualificado'],
  ['reuniao', 'Reunião'],
  ['ganho', 'Ganho'],
  ['perdido', 'Perdido'],
];

export const CALL_STATUS_OPTIONS: [string, string][] = [
  ['completed', 'Concluída'],
  ['no_answer', 'Não atendeu'],
  ['failed', 'Falhou'],
  ['cancelled', 'Cancelada'],
  ['retry_wait', 'Aguardando retry'],
  ['reserved', 'Reservada'],
  ['dialing', 'Discando'],
  ['media_active', 'Em chamada'],
];

export const SOURCE_OPTIONS: [string, string][] = [
  ['all', 'Todas as origens'],
  ['automatico', 'Automática'],
  ['manual', 'Manual'],
];

export const labelFor = (options: [string, string][], code: string) => options.find(([value]) => value === code)?.[1] ?? code;

// Espelho de GOAL_METRIC_CATALOG em apps/api/src/modules/metrics/metrics.definitions.ts
export const GOAL_METRIC_OPTIONS: [string, string][] = [
  ['calls_made', 'Chamadas realizadas'],
  ['leads_worked', 'Leads trabalhados'],
  ['answer_rate', 'Taxa de atendimento'],
  ['positive_results', 'Resultados positivos'],
  ['stage_advances', 'Avanço de etapa'],
  ['conversions', 'Conversão'],
  ['connected_seconds', 'Tempo conectado'],
];
export const GOAL_METRIC_UNIT: Record<string, 'count' | 'seconds' | 'percent'> = {
  calls_made: 'count', leads_worked: 'count', answer_rate: 'percent', positive_results: 'count',
  stage_advances: 'count', conversions: 'count', connected_seconds: 'seconds',
};
export const GOAL_SCOPE_OPTIONS: [string, string][] = [
  ['organization', 'Organização'],
  ['sdr', 'SDR'],
  ['folder', 'Pasta'],
];

// Espelha o plano seção 4 ("Métricas e definições oficiais") — exibido no
// painel de ajuda da página ("adicionar explicação das métricas", Fase 5).
export const METRIC_DEFINITIONS: { label: string; formula: string }[] = [
  { label: 'Chamadas realizadas', formula: 'Registros de chamada criados no período (inclui automáticas e manuais)' },
  { label: 'Leads únicos trabalhados', formula: 'Quantidade de leads distintos com pelo menos uma chamada no período' },
  { label: 'Atendidas', formula: 'Chamadas com conexão registrada' },
  { label: 'Taxa de atendimento', formula: 'Atendidas ÷ chamadas realizadas' },
  { label: 'Tentativas médias por lead', formula: 'Chamadas ÷ leads únicos trabalhados' },
  { label: 'Tempo conectado', formula: 'Soma do tempo de conversa (separado do tempo de toque)' },
  { label: 'Duração média', formula: 'Tempo conectado ÷ chamadas atendidas' },
  { label: 'Taxa de pós-atendimento', formula: 'Atendidas com registro concluído ÷ atendidas' },
  { label: 'Avanço de etapa', formula: 'Leads que mudaram de etapa no período (histórico, não apenas o estado atual)' },
  { label: 'Resultado positivo', formula: 'Resultados classificados como positivos ou conversão no catálogo do tenant' },
  { label: 'Conversão', formula: 'Resultado ou etapa definida como conversão pelo catálogo do tenant' },
  { label: 'Utilização do número', formula: 'Chamadas simultâneas atuais ÷ limite configurado' },
];
