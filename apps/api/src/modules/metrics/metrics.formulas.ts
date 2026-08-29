// Fórmulas oficiais da área de Métricas (plano seção 4). Funções puras e
// testáveis (metrics.formulas.spec.ts) — nenhuma delas acessa o banco.

/** Percentual numerator/denominator, uma casa decimal. Denominador zero => 0 (plano seção 4.1). */
export function safeRate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Taxa de atendimento = atendidas ÷ chamadas realizadas. */
export function answerRate(callsAnswered: number, callsMade: number): number {
  return safeRate(callsAnswered, callsMade);
}

/** Tentativas médias por lead = chamadas ÷ leads únicos trabalhados. Sem leads => 0. */
export function avgAttemptsPerLead(callsMade: number, uniqueLeadsWorked: number): number {
  if (!uniqueLeadsWorked) return 0;
  return Math.round((callsMade / uniqueLeadsWorked) * 100) / 100;
}

/** Duração média = tempo conectado ÷ chamadas atendidas (nunca inclui não atendidas). */
export function avgConnectedDurationSeconds(connectedSeconds: number, callsAnswered: number): number {
  if (!callsAnswered) return 0;
  return Math.round(connectedSeconds / callsAnswered);
}

/** Taxa de pós-atendimento = atendidas com wrap-up concluído ÷ atendidas. */
export function wrapUpRate(wrapUpsCompleted: number, callsAnswered: number): number {
  return safeRate(wrapUpsCompleted, callsAnswered);
}

/** Capacidade do número = chamadas simultâneas atuais ÷ limite configurado. */
export function numberUtilization(activeCalls: number, maxConcurrentCalls: number): number {
  return safeRate(activeCalls, maxConcurrentCalls);
}

/** Utilização do SDR = tempo em chamada/pós-atendimento ÷ tempo disponível monitorado. */
export function sdrUtilization(busySeconds: number, monitoredSeconds: number): number {
  return safeRate(busySeconds, monitoredSeconds);
}

export type ComparisonDelta = { changeAbsolute: number | null; changePercent: number | null };

/** Variação em relação ao período de comparação. Sem período anterior disponível => null (não zero, para não sugerir queda de 100%). */
export function compareToPrevious(current: number, previous: number | null): ComparisonDelta {
  if (previous === null) return { changeAbsolute: null, changePercent: null };
  const changeAbsolute = current - previous;
  const changePercent = previous === 0 ? (current === 0 ? 0 : null) : Math.round((changeAbsolute / previous) * 1000) / 10;
  return { changeAbsolute, changePercent };
}

/**
 * Deslocamento (em minutos) entre UTC e o fuso informado, no instante `date`.
 * Usa Intl (sem dependência externa) para lidar corretamente com qualquer fuso,
 * incluindo os que observam horário de verão.
 */
export function timezoneOffsetMinutes(timeZone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) if (part.type !== 'literal') parts[part.type] = part.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Limites (início e fim, em UTC) do dia civil `YYYY-MM-DD` no fuso do tenant (plano seção 4.1). */
export function dayRangeInTimezone(dateStr: string, timeZone: string): { startUtc: Date; endUtc: Date } {
  const naiveStart = new Date(`${dateStr}T00:00:00.000Z`);
  const naiveEnd = new Date(`${dateStr}T23:59:59.999Z`);
  const startUtc = new Date(naiveStart.getTime() - timezoneOffsetMinutes(timeZone, naiveStart) * 60_000);
  const endUtc = new Date(naiveEnd.getTime() - timezoneOffsetMinutes(timeZone, naiveEnd) * 60_000);
  return { startUtc, endUtc };
}

/** Data civil `YYYY-MM-DD` de `date` no fuso informado — usada para calcular presets como "hoje"/"últimos 7 dias". */
export function civilDateInTimezone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Desloca uma data civil `YYYY-MM-DD` por `days` dias (aritmética de calendário, não de instante). */
export function shiftDateStr(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Número de dias entre duas datas civis `YYYY-MM-DD` (to - from). */
export function daysBetweenDateStrs(fromStr: string, toStr: string): number {
  const from = new Date(`${fromStr}T00:00:00.000Z`).getTime();
  const to = new Date(`${toStr}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

/**
 * Último dia "completo" (civil, anterior a hoje) dentro de `[startDay, endDay]`
 * — usado por `MetricsRepository.trends()` para decidir até que dia pode vir
 * do rollup diário materializado em vez de ser calculado ao vivo (plano
 * seção 13, Fase 8, item 1). "Hoje" nunca é completo, mesmo já avançado —
 * evita servir dado potencialmente desatualizado para o dia corrente.
 * Retorna `null` quando nenhum dia do intervalo já terminou (ex.: período é
 * só "hoje", ou começa no futuro).
 */
export function lastCompleteDayInRange(startDay: string, endDay: string, todayDay: string): string | null {
  const candidateEnd = endDay < todayDay ? endDay : shiftDateStr(todayDay, -1);
  return candidateEnd >= startDay ? candidateEnd : null;
}
