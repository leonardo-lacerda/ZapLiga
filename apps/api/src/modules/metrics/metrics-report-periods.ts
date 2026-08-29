import { shiftDateStr } from './metrics.formulas';

export type ReportPeriodPreset = 'custom' | 'this_week' | 'last_week' | 'this_month' | 'last_month';

export const REPORT_PERIOD_PRESETS: ReportPeriodPreset[] = ['custom', 'this_week', 'last_week', 'this_month', 'last_month'];

/**
 * Resolve os presets "relatório semanal e mensal" (plano seção 6.8) para um
 * intervalo `YYYY-MM-DD` concreto, ancorado em `today` (data civil no fuso
 * do tenant). Semana = segunda a domingo (padrão ISO). `null` para 'custom'
 * — quem chama usa `from`/`to` explícitos nesse caso.
 */
export function resolveReportPeriod(preset: ReportPeriodPreset, today: string): { from: string; to: string } | null {
  if (preset === 'custom') return null;

  const isoDayOfWeek = new Date(`${today}T00:00:00.000Z`).getUTCDay() || 7; // domingo (0) -> 7
  const thisMonday = shiftDateStr(today, -(isoDayOfWeek - 1));
  const thisSunday = shiftDateStr(thisMonday, 6);
  if (preset === 'this_week') return { from: thisMonday, to: thisSunday };
  if (preset === 'last_week') return { from: shiftDateStr(thisMonday, -7), to: shiftDateStr(thisSunday, -7) };

  const [year, month] = today.split('-').map(Number);
  const thisMonthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  if (preset === 'this_month') {
    const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    return { from: thisMonthStart, to: shiftDateStr(nextMonthStart, -1) };
  }
  // last_month
  const lastMonthEnd = shiftDateStr(thisMonthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
  return { from: lastMonthStart, to: lastMonthEnd };
}
