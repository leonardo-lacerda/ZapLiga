import { generateStealthProfile } from './stealth-profile';
import { StealthService } from './stealth.service';

describe('StealthService', () => {
  const stored = { version: 1, surface: 'WEB_BROWSER', device: { os: 'Mac OS', platform: 'safari' }, client: { locale: 'pt_BR' } };
  const make = (line: Record<string, unknown>, geelarkConflict?: string) => {
    const db = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT * FROM whatsapp_numbers')) return { rows: [{ id: 'n1', tenant_id: 't1', ...line }] };
        if (sql.includes('FROM provisioning_jobs mine')) return { rows: geelarkConflict ? [{ label: geelarkConflict }] : [] };
        if (sql.includes('UPDATE whatsapp_numbers SET stealth_enabled')) return { rows: [{ id: 'n1', stealth_enabled: params[2], stealth_profile: params[3] && JSON.parse(String(params[3])), stealth_profile_frozen_at: '2026-11-26T12:00:00Z', created_at: '2026-11-26T12:00:00Z' }] };
        return { rows: [] };
      }),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const entitlement = { assertAction: jest.fn(async () => undefined) };
    return { service: new StealthService(db as any, audit as any, entitlement as any), db, audit };
  };
  const update = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE whatsapp_numbers SET stealth_enabled'));
  afterEach(() => { delete process.env.STEALTH_KILLSWITCH; });

  it('generates and freezes the profile the first time the switch goes on', async () => {
    const { service, db, audit } = make({ stealth_enabled: false, stealth_profile: null, stealth_profile_frozen_at: null });

    const line = await service.setEnabled('t1', 'u1', 'n1', true);

    const [sql, params] = update(db);
    expect(sql).toContain('stealth_profile_frozen_at = COALESCE(stealth_profile_frozen_at');
    expect(params.slice(0, 3)).toEqual(['n1', 't1', true]);
    expect(JSON.parse(params[3])).toEqual(generateStealthProfile('n1'));
    expect(line.stealth_coverage).toBe('FULL');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'number.stealth_changed' }));
  });

  it('reuses the frozen profile when the switch goes on again', async () => {
    const { service, db } = make({ stealth_enabled: false, stealth_profile: stored, stealth_profile_frozen_at: '2026-11-20T00:00:00Z' });

    await service.setEnabled('t1', 'u1', 'n1', true);

    expect(JSON.parse(update(db)[1][3])).toEqual(stored);
  });

  it('keeps the profile when the switch goes off', async () => {
    const { service, db } = make({ stealth_enabled: true, stealth_profile: stored, stealth_profile_frozen_at: '2026-11-20T00:00:00Z' });

    await service.setEnabled('t1', 'u1', 'n1', false);

    expect(update(db)[1][2]).toBe(false);
    expect(JSON.parse(update(db)[1][3])).toEqual(stored);
  });

  it('refuses to turn a line on while the killswitch is on', async () => {
    process.env.STEALTH_KILLSWITCH = 'true';
    const { service, db } = make({ stealth_enabled: false });

    await expect(service.setEnabled('t1', 'u1', 'n1', true)).rejects.toThrow('STEALTH_KILLSWITCH');
    expect(update(db)).toBeUndefined();
  });

  it('refuses a second camouflaged line on the same GeeLark phone', async () => {
    const { service, db } = make({ stealth_enabled: false }, 'Previtas 12');

    await expect(service.setEnabled('t1', 'u1', 'n1', true)).rejects.toThrow('Previtas 12');
    expect(update(db)).toBeUndefined();
  });

  it('compares the arms per 100 line-days and per 100 calls', async () => {
    const row = { cohort: 'stealth', lines: 4, line_days: 20, device_removed: 1, account_locked: 1, lost: 2, median_hours_to_loss: 30, lines_7d: 4, alive_7d: 2, lines_14d: 0, alive_14d: 0, calls: 400, answered: 120, call_acks: 410, nacks_463: 8, logins: 30 };
    const db = { query: jest.fn(async () => ({ rows: [row] })) };
    const service = new StealthService(db as any, {} as any, {} as any);

    const result = await service.cohorts('t1', 28);

    expect(result.cohorts[0]).toMatchObject({ losses_per_100_line_days: 10, losses_per_100_calls: 0.5, nacks_463_per_100_calls: 2, logins_per_line_day: 1.5 });
  });
});
