import { daysBetweenDateStrs, safeRate } from './metrics.formulas';

export type GoalTrend = 'ahead' | 'on_track' | 'behind' | 'not_started';

export type GoalProgress = {
  actual: number;
  progressPercent: number;
  /** Quanto já deveria ter sido atingido a essa altura do período, num ritmo linear. */
  expectedPace: number;
  /** Estimativa do valor final mantido o ritmo atual; igual a `actual` quando o período já terminou. */
  projectedFinal: number;
  /** target - projectedFinal (positivo = falta, negativo = já superou a projeção). */
  difference: number;
  trend: GoalTrend;
  periodEnded: boolean;
};

const TREND_TOLERANCE = 0.05;

/**
 * Progresso, projeção, diferença e tendência de uma meta (plano seção 6.7:
 * "Exibir progresso, projeção, diferença para a meta e tendência").
 * Função pura — `today` é injetado para ficar testável sem depender do
 * relógio real.
 */
export function computeGoalProgress(target: number, actual: number, periodFrom: string, periodTo: string, today: string): GoalProgress {
  const totalDays = daysBetweenDateStrs(periodFrom, periodTo) + 1;
  const periodEnded = today > periodTo;
  const periodStarted = today >= periodFrom;
  const clampedToday = today > periodTo ? periodTo : today < periodFrom ? periodFrom : today;
  const elapsedDays = periodStarted ? daysBetweenDateStrs(periodFrom, clampedToday) + 1 : 0;

  const progressPercent = safeRate(actual, target);
  const expectedPace = periodStarted ? Math.round(target * (elapsedDays / totalDays) * 100) / 100 : 0;
  const projectedFinal = periodEnded ? actual : elapsedDays > 0 ? Math.round(actual * (totalDays / elapsedDays) * 100) / 100 : 0;
  const difference = Math.round((target - projectedFinal) * 100) / 100;

  let trend: GoalTrend = 'not_started';
  if (periodStarted) {
    if (expectedPace === 0) trend = actual > 0 ? 'ahead' : 'on_track';
    else if (actual >= expectedPace * (1 + TREND_TOLERANCE)) trend = 'ahead';
    else if (actual <= expectedPace * (1 - TREND_TOLERANCE)) trend = 'behind';
    else trend = 'on_track';
  }

  return { actual, progressPercent, expectedPace, projectedFinal, difference, trend, periodEnded };
}
