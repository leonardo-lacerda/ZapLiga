import { resolveReportPeriod } from './metrics-report-periods';

describe('resolveReportPeriod', () => {
  it('returns null for custom, leaving the caller to use explicit from/to', () => {
    expect(resolveReportPeriod('custom', '2026-08-29')).toBeNull();
  });

  it('resolves this_week to the Monday-Sunday span containing today', () => {
    // 2026-08-29 is a Saturday.
    expect(resolveReportPeriod('this_week', '2026-08-29')).toEqual({ from: '2026-08-24', to: '2026-08-30' });
  });

  it('resolves this_week correctly when today is the Monday itself', () => {
    expect(resolveReportPeriod('this_week', '2026-08-24')).toEqual({ from: '2026-08-24', to: '2026-08-30' });
  });

  it('resolves this_week correctly when today is the Sunday itself', () => {
    expect(resolveReportPeriod('this_week', '2026-08-30')).toEqual({ from: '2026-08-24', to: '2026-08-30' });
  });

  it('resolves last_week to the 7 days immediately before this_week', () => {
    expect(resolveReportPeriod('last_week', '2026-08-29')).toEqual({ from: '2026-08-17', to: '2026-08-23' });
  });

  it('resolves this_month to the full calendar month containing today', () => {
    expect(resolveReportPeriod('this_month', '2026-08-15')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('resolves this_month correctly for a 30-day month', () => {
    expect(resolveReportPeriod('this_month', '2026-04-05')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('resolves last_month to the previous calendar month', () => {
    expect(resolveReportPeriod('last_month', '2026-08-15')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('resolves last_month across a year boundary', () => {
    expect(resolveReportPeriod('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('resolves this_month across a year boundary for December', () => {
    expect(resolveReportPeriod('this_month', '2026-12-20')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
