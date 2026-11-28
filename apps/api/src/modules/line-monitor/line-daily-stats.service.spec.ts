import { LineDailyStatsService } from './line-daily-stats.service';
import { daysBetween, localDay, shiftDay } from './line-monitor.rules';

describe('LineDailyStatsService', () => {
  const make = (opts: { hasRows?: boolean; firstDay?: string | null; nightly?: boolean } = {}) => {
    const db = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM tenants')) return { rows: [{ id: 't1', timezone: 'America/Sao_Paulo' }] };
        if (sql.includes('SELECT 1 FROM line_daily_stats')) return { rows: opts.hasRows ? [{}] : [] };
        if (sql.includes('min(created_at)')) return { rows: [{ day: opts.firstDay ?? null }] };
        return { rows: [] };
      }),
    };
    const learnings = { hasNightlyRun: jest.fn(async () => opts.nightly ?? true), compute: jest.fn(async () => ({})) };
    return { db, learnings, service: new LineDailyStatsService(db as any, learnings as any) };
  };
  const upserts = (db: { query: jest.Mock }) => db.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO line_daily_stats')).map(([, params]) => params as unknown[]);

  it('rebuilds today, and yesterday in the first hours of the day', async () => {
    const { db, service } = make({ hasRows: true });
    await service.tick(new Date('2026-11-28T04:30:00Z')); // 01:30 in São Paulo
    expect(upserts(db).map((params) => params[1])).toEqual(['2026-11-27', '2026-11-28']);
    expect(upserts(db)[0]).toEqual(['t1', '2026-11-27', 'America/Sao_Paulo', false, ['device_removed', 'account_locked', 'temp_banned'], ['connected', 'online', 'ready', 'authenticated']]);

    db.query.mockClear();
    await service.tick(new Date('2026-11-28T15:00:00Z'));
    expect(upserts(db).map((params) => params[1])).toEqual(['2026-11-28']);
  });

  it('rebuilds every past day once when the tenant has no row yet, marking the setup as estimated', async () => {
    const { db, service } = make({ hasRows: false, firstDay: '2026-11-25' });
    await service.tick(new Date('2026-11-28T15:00:00Z'));
    const rebuilt = upserts(db).filter((params) => params[3] === true).map((params) => params[1]);
    expect(rebuilt).toEqual(['2026-11-25', '2026-11-26', '2026-11-27']);
  });

  it('saves the nightly learnings once, after 3h', async () => {
    const early = make({ hasRows: true, nightly: false });
    await early.service.tick(new Date('2026-11-28T05:00:00Z')); // 02:00
    expect(early.learnings.compute).not.toHaveBeenCalled();

    const late = make({ hasRows: true, nightly: false });
    await late.service.tick(new Date('2026-11-28T07:00:00Z')); // 04:00
    expect(late.learnings.compute).toHaveBeenCalledWith('t1', { trigger: 'nightly' });

    const done = make({ hasRows: true, nightly: true });
    await done.service.tick(new Date('2026-11-28T07:00:00Z'));
    expect(done.learnings.compute).not.toHaveBeenCalled();
  });

  it('works out civil days in the tenant timezone', () => {
    expect(localDay(new Date('2026-11-28T01:19:00Z'), 'America/Sao_Paulo')).toEqual({ day: '2026-11-27', hour: 22 });
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });
});
