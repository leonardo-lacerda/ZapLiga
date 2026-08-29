import { computeGoalProgress } from './metrics-goals.progress';

describe('computeGoalProgress', () => {
  it('reports not_started before the period begins', () => {
    const progress = computeGoalProgress(100, 0, '2026-03-10', '2026-03-20', '2026-03-05');
    expect(progress.trend).toBe('not_started');
    expect(progress.expectedPace).toBe(0);
    expect(progress.projectedFinal).toBe(0);
  });

  it('is on_track when the pace matches the elapsed fraction of the period', () => {
    // 10-day period (01 to 10), today is day 5 (5 days elapsed) -> half the target expected.
    const progress = computeGoalProgress(100, 50, '2026-03-01', '2026-03-10', '2026-03-05');
    expect(progress.expectedPace).toBe(50);
    expect(progress.trend).toBe('on_track');
  });

  it('is ahead when comfortably above the expected pace', () => {
    const progress = computeGoalProgress(100, 80, '2026-03-01', '2026-03-10', '2026-03-05');
    expect(progress.trend).toBe('ahead');
  });

  it('is behind when comfortably below the expected pace', () => {
    const progress = computeGoalProgress(100, 20, '2026-03-01', '2026-03-10', '2026-03-05');
    expect(progress.trend).toBe('behind');
  });

  it('projects the final value by extrapolating the current pace', () => {
    // 5 of 10 days elapsed, 50 achieved -> projected final = 50 * (10/5) = 100.
    const progress = computeGoalProgress(120, 50, '2026-03-01', '2026-03-10', '2026-03-05');
    expect(progress.projectedFinal).toBe(100);
    expect(progress.difference).toBe(20);
  });

  it('uses the actual value as the final projection once the period has ended, without extrapolating further', () => {
    const progress = computeGoalProgress(100, 60, '2026-03-01', '2026-03-10', '2026-03-15');
    expect(progress.periodEnded).toBe(true);
    expect(progress.projectedFinal).toBe(60);
    expect(progress.difference).toBe(40);
  });

  it('computes progressPercent as a zero-safe rate against the target', () => {
    expect(computeGoalProgress(0, 0, '2026-03-01', '2026-03-10', '2026-03-05').progressPercent).toBe(0);
    expect(computeGoalProgress(50, 25, '2026-03-01', '2026-03-10', '2026-03-05').progressPercent).toBe(50);
  });

  it('treats a same-day period as fully elapsed on that day', () => {
    const progress = computeGoalProgress(10, 4, '2026-03-05', '2026-03-05', '2026-03-05');
    expect(progress.periodEnded).toBe(false);
    expect(progress.expectedPace).toBe(10);
    expect(progress.projectedFinal).toBe(4);
  });
});
