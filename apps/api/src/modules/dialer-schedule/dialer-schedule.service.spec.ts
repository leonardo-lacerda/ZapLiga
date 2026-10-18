import { DialerScheduleService, evaluateSchedule, localDateTimeParts } from './dialer-schedule.service';

const schedule = {
  timezone: 'America/Sao_Paulo',
  windows: [
    { day_of_week: 1, start_time: '09:00', end_time: '18:00' },
    { day_of_week: 2, start_time: '09:00', end_time: '18:00' },
  ],
  exceptions: [],
};

describe('dialer schedule rules', () => {
  it('converts the instant using the tenant timezone', () => {
    expect(localDateTimeParts(new Date('2026-08-31T12:00:00.000Z'), 'America/Sao_Paulo')).toEqual({
      local_date: '2026-08-31', local_time: '09:00', day_of_week: 1,
    });
  });

  it('allows the beginning and rejects the exclusive end of a window', () => {
    expect(evaluateSchedule(schedule, new Date('2026-08-31T12:00:00.000Z')).allowed).toBe(true);
    expect(evaluateSchedule(schedule, new Date('2026-08-31T21:00:00.000Z')).allowed).toBe(false);
  });

  it('closes a normally open day through an exception', () => {
    const state = evaluateSchedule({ ...schedule, exceptions: [{ local_date: '2026-08-31', is_closed: true, start_time: null, end_time: null, reason: 'feriado' }] }, new Date('2026-08-31T15:00:00.000Z'));
    expect(state).toMatchObject({ allowed: false, reason: 'feriado' });
  });

  it('can open a normally closed day through an exception window', () => {
    const state = evaluateSchedule({ ...schedule, exceptions: [{ local_date: '2026-08-30', is_closed: false, start_time: '10:00', end_time: '12:00', reason: 'plantão' }] }, new Date('2026-08-30T14:30:00.000Z'));
    expect(state).toMatchObject({ allowed: true, local_time: '11:30' });
  });
});

describe('dialer schedule switch', () => {
  // Sunday 12:00 in São Paulo: outside every window above
  const sunday = new Date('2026-08-30T15:00:00.000Z');
  const build = (enforced: boolean) => {
    const db = { query: jest.fn() };
    // the schedule comes from the cache
    const redis = { client: { get: jest.fn(async () => JSON.stringify(schedule)), set: jest.fn() }, incrementMetric: jest.fn() };
    const flags = { enabled: jest.fn(async () => enforced) };
    return new DialerScheduleService(db as any, redis as any, flags as any);
  };

  it('lets a tenant without schedule enforcement call, and dial automatically, at any time', async () => {
    const service = build(false);
    await expect(service.evaluate('t1', sunday)).resolves.toMatchObject({ allowed: true, reason: 'feature_disabled' });
    await expect(service.assertAllowed('t1', sunday)).resolves.toMatchObject({ allowed: true });
  });

  it('keeps blocking outside the windows when the schedule is enforced', async () => {
    const service = build(true);
    await expect(service.evaluate('t1', sunday)).resolves.toMatchObject({ allowed: false, reason: 'outside_schedule' });
    await expect(service.assertAllowed('t1', sunday)).rejects.toMatchObject({ response: { code: 'outside_dialer_schedule' } });
  });
});
