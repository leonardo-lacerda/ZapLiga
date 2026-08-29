import { avgAttemptsPerLead, safeRate } from './metrics.formulas';
import { MetricsAlert } from './metrics.types';

// Limiares dos alertas (plano seção 6.6). A maioria não é configurável pela
// organização ainda (isso depende de uma tela de configurações que o plano
// não chega a detalhar), então usamos padrões razoáveis e documentados, do
// mesmo jeito que a Fase 1 usou um timezone padrão antes da coluna por
// tenant existir. "Volume abaixo da meta" é a exceção — usa o limiar real
// que a própria organização definiu (Fase 6, metric_goals).
const MIN_SAMPLE_SIZE = 10;
const ANSWER_RATE_DROP_POINTS = 15;
const FAILURE_RATE_INCREASE_POINTS = 15;
const MIN_UNIQUE_LEADS_FOR_ATTEMPTS_CHECK = 5;
const ATTEMPTS_PER_LEAD_THRESHOLD = 4;
const MIN_FAILURES_FOR_CONCENTRATION = 5;
const NUMBER_FAILURE_SHARE_THRESHOLD = 0.5;

export type AlertCallAggregates = { callsMade: number; callsAnswered: number; failedCalls: number; uniqueLeadsWorked: number };
export type AlertRealtime = { activeCalls: number; sdrsAvailable: number; leadsReady: number; numbersInQuarantine: number; queueStalled: boolean };
export type AlertFolder = { name: string; isActive: boolean; currentQueue: number };
export type AlertNumber = { label: string; failed: number };
export type AlertOpenWrapUp = { sdrName: string; minutesOpen: number };
export type AlertGoalBehind = { label: string; metricLabel: string; progressPercent: number };

export type BuildAlertsInput = {
  current: AlertCallAggregates;
  previous: AlertCallAggregates;
  realtime: AlertRealtime;
  folders: AlertFolder[];
  numbers: AlertNumber[];
  /** Já ordenado do mais antigo (mais tempo aberto) para o mais recente. */
  openWrapUps: AlertOpenWrapUp[];
  /** Metas ativas cuja projeção está abaixo do ritmo esperado (trend = 'behind'). */
  goalsBehind: AlertGoalBehind[];
};

/**
 * Gera os alertas baseados em regra da página de Métricas (plano seção 6.6).
 * Função pura — nenhuma chamada ao banco aqui, só interpretação de dados já
 * calculados, o que a torna testável sem mocks.
 *
 * Cada alerta traz evidência (números concretos) e uma ação recomendada
 * redigida como possibilidade, nunca como causa confirmada — os dados aqui
 * mostram correlação, não causalidade (plano: "alertas não devem afirmar
 * causalidade quando os dados apenas indicam correlação").
 */
export function buildAlerts(input: BuildAlertsInput): MetricsAlert[] {
  const { current, previous, realtime, folders, numbers, openWrapUps, goalsBehind } = input;
  const alerts: MetricsAlert[] = [];

  if (realtime.queueStalled) {
    alerts.push({
      id: 'queue_stalled', severity: 'critical', code: 'queue_stalled',
      title: 'Fila parada',
      evidence: `${realtime.leadsReady} lead(s) prontos para discagem, mas nenhuma chamada ativa e nenhum SDR disponível agora.`,
      recommendedAction: 'Verifique se há SDRs conectados e disponíveis, e se existe ao menos um número apto a discar.',
    });
  } else if (realtime.leadsReady > 0 && realtime.sdrsAvailable === 0) {
    alerts.push({
      id: 'no_sdr_available', severity: 'warning', code: 'no_sdr_available',
      title: 'Nenhum SDR disponível com leads prontos',
      evidence: `${realtime.leadsReady} lead(s) prontos, mas nenhum SDR está disponível no momento.`,
      recommendedAction: 'Confirme se a equipe está conectada e marcada como disponível.',
    });
  }

  if (realtime.numbersInQuarantine > 0) {
    alerts.push({
      id: 'numbers_in_quarantine', severity: 'warning', code: 'numbers_in_quarantine',
      title: 'Número(s) em quarentena',
      evidence: `${realtime.numbersInQuarantine} número(s) estão em quarentena agora.`,
      recommendedAction: 'Aguarde o fim da quarentena ou adicione outras linhas para não depender de um único número.',
    });
  }

  if (current.callsMade >= MIN_SAMPLE_SIZE && previous.callsMade >= MIN_SAMPLE_SIZE) {
    const curRate = safeRate(current.callsAnswered, current.callsMade);
    const prevRate = safeRate(previous.callsAnswered, previous.callsMade);
    if (prevRate - curRate >= ANSWER_RATE_DROP_POINTS) {
      alerts.push({
        id: 'answer_rate_drop', severity: 'warning', code: 'answer_rate_drop',
        title: 'Queda na taxa de atendimento',
        evidence: `Taxa de atendimento caiu de ${prevRate}% para ${curRate}% em relação ao período anterior (${current.callsAnswered}/${current.callsMade} vs ${previous.callsAnswered}/${previous.callsMade}).`,
        recommendedAction: 'Pode estar associado à disponibilidade dos SDRs, ao horário das tentativas ou à qualidade da base de leads — vale checar cada frente antes de concluir a causa.',
      });
    }

    const curFailRate = safeRate(current.failedCalls, current.callsMade);
    const prevFailRate = safeRate(previous.failedCalls, previous.callsMade);
    if (curFailRate - prevFailRate >= FAILURE_RATE_INCREASE_POINTS) {
      alerts.push({
        id: 'failure_rate_increase', severity: 'warning', code: 'failure_rate_increase',
        title: 'Aumento de falhas técnicas',
        evidence: `Taxa de falha subiu de ${prevFailRate}% para ${curFailRate}% em relação ao período anterior (${current.failedCalls}/${current.callsMade} vs ${previous.failedCalls}/${previous.callsMade}).`,
        recommendedAction: 'Pode indicar instabilidade em um número específico ou no provedor — confira a saúde dos números antes de continuar discando.',
      });
    }
  }

  if (current.uniqueLeadsWorked >= MIN_UNIQUE_LEADS_FOR_ATTEMPTS_CHECK) {
    const attemptsPerLead = avgAttemptsPerLead(current.callsMade, current.uniqueLeadsWorked);
    if (attemptsPerLead >= ATTEMPTS_PER_LEAD_THRESHOLD) {
      alerts.push({
        id: 'attempts_per_lead_anomaly', severity: 'info', code: 'attempts_per_lead_anomaly',
        title: 'Diferença anormal entre chamadas e leads únicos',
        evidence: `Em média, cada lead recebeu ${attemptsPerLead} tentativas no período (${current.callsMade} chamadas para ${current.uniqueLeadsWorked} leads únicos).`,
        recommendedAction: 'Confira o limite de tentativas configurado no discador — pode haver leads sendo re-discados além do esperado.',
      });
    }
  }

  const totalFailures = numbers.reduce((sum, number) => sum + number.failed, 0);
  if (totalFailures >= MIN_FAILURES_FOR_CONCENTRATION) {
    const worst = numbers.reduce((max, number) => number.failed > max.failed ? number : max, numbers[0]);
    if (worst.failed / totalFailures >= NUMBER_FAILURE_SHARE_THRESHOLD) {
      alerts.push({
        id: 'number_failure_concentration', severity: 'warning', code: 'number_failure_concentration',
        title: 'Concentração de falhas em um número',
        evidence: `O número "${worst.label}" responde por ${worst.failed} de ${totalFailures} falhas no período (${safeRate(worst.failed, totalFailures)}%).`,
        recommendedAction: 'Verifique a saúde desse número especificamente antes de continuar usando-o para chamadas automáticas.',
      });
    }
  }

  const staleFolders = folders.filter((folder) => folder.isActive && folder.currentQueue === 0);
  if (staleFolders.length) {
    const names = staleFolders.slice(0, 3).map((folder) => folder.name).join(', ');
    const extra = staleFolders.length > 3 ? ` e mais ${staleFolders.length - 3}` : '';
    alerts.push({
      id: 'folder_without_eligible_leads', severity: 'info', code: 'folder_without_eligible_leads',
      title: 'Pasta ativa sem leads elegíveis',
      evidence: `${staleFolders.length} pasta(s) ativa(s) sem nenhum lead elegível na fila agora: ${names}${extra}.`,
      recommendedAction: 'Importe novos contatos ou revise os critérios de elegibilidade dessas pastas.',
    });
  }

  if (openWrapUps.length) {
    const longestOpen = openWrapUps[0];
    alerts.push({
      id: 'pending_wrap_ups', severity: 'info', code: 'pending_wrap_ups',
      title: 'Pós-atendimentos pendentes',
      evidence: `${openWrapUps.length} SDR(s) em pós-atendimento há mais tempo que o esperado — ${longestOpen.sdrName} há ${longestOpen.minutesOpen} min.`,
      recommendedAction: 'Confirme com os SDRs se o registro do resultado está travado ou se a chamada anterior não foi encerrada corretamente.',
    });
  }

  if (goalsBehind.length) {
    const first = goalsBehind[0];
    const names = goalsBehind.slice(0, 3).map((goal) => `${goal.label} (${goal.metricLabel}, ${goal.progressPercent}% da meta)`).join('; ');
    const extra = goalsBehind.length > 3 ? ` e mais ${goalsBehind.length - 3}` : '';
    alerts.push({
      id: 'goals_behind', severity: 'warning', code: 'goals_behind',
      title: 'Volume abaixo da meta',
      evidence: `${goalsBehind.length} meta(s) com ritmo abaixo do esperado para o período: ${names}${extra}.`,
      recommendedAction: `Revise a distribuição de leads e a disponibilidade da equipe para "${first.label}", ou ajuste a meta se o cenário mudou.`,
    });
  }

  return alerts;
}
