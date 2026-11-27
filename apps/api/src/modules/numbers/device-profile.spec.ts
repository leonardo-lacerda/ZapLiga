import { NumbersService } from './numbers.service';
import { buildDeviceProfile, profileViolations, stableUuid, androidVersionNumber } from './device-profile';

const profile = (overrides: Record<string, unknown> = {}) => buildDeviceProfile({
  geelarkPhoneId: 'phone-1',
  androidVersion: 'Android 14',
  phoneId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  ...overrides,
});

describe('device profile', () => {
  describe('androidVersionNumber', () => {
    it('keeps the version number of the GeeLark label', () => {
      expect(androidVersionNumber('Android 14')).toBe('14');
      expect(androidVersionNumber('Android 11')).toBe('11');
    });

    it('falls back to 14 when the label carries no number', () => {
      expect(androidVersionNumber('')).toBe('14');
      expect(androidVersionNumber(undefined)).toBe('14');
    });
  });

  describe('stableUuid', () => {
    it('is deterministic for the same seed', () => {
      expect(stableUuid('phone-1')).toBe(stableUuid('phone-1'));
    });

    it('differs between seeds', () => {
      expect(stableUuid('phone-1')).not.toBe(stableUuid('phone-2'));
    });

    it('is a v5-shaped UUID', () => {
      expect(stableUuid('phone-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('buildDeviceProfile', () => {
    it('declares an Android phone with the phone network and the given version', () => {
      const value = profile();

      expect(value.surface).toBe('ANDROID_PHONE');
      expect(value.user_agent.platform).toBe('ANDROID');
      expect(value.user_agent.mcc).toBe('724');
      expect(value.user_agent.mnc).toBe('006');
      expect(value.user_agent.os_version).toBe('14');
      expect(value.user_agent.device_type).toBe('PHONE');
      expect(value.web_info).toBeNull();
    });

    it('pads the network codes to three digits', () => {
      expect(profile({ mcc: '724', mnc: '6' }).user_agent.mnc).toBe('006');
      expect(profile({ mcc: '724', mnc: '31' }).user_agent.mnc).toBe('031');
    });

    it('derives device_exp_id from the cloud phone, so the same phone keeps the same value', () => {
      expect(profile().user_agent.device_exp_id).toBe(profile().user_agent.device_exp_id);
      expect(profile({ geelarkPhoneId: 'other' }).user_agent.device_exp_id).not.toBe(profile().user_agent.device_exp_id);
    });

    it('fills web_info only for a Web surface', () => {
      const web = profile({ surface: 'WEB' });
      expect(web.user_agent.platform).toBe('WEB');
      expect(web.web_info).toEqual({ browser: 'Chrome', browser_version: '120' });
    });
  });

  describe('profileViolations', () => {
    it('accepts a coherent profile', () => {
      expect(profileViolations(profile())).toEqual([]);
      expect(profileViolations(profile({ surface: 'WEB' }))).toEqual([]);
    });

    it('rejects a Web surface without web_info', () => {
      const broken = { ...profile({ surface: 'WEB' }), web_info: null };
      expect(profileViolations(broken)).toContain('a WEB surface must carry web_info');
    });

    it('rejects an Android surface carrying web_info', () => {
      const broken = { ...profile(), web_info: { browser: 'Chrome', browser_version: '120' } };
      expect(profileViolations(broken)).toContain('an Android surface must not carry web_info');
    });

    it('rejects network codes that are not three digits', () => {
      const broken = { ...profile(), user_agent: { ...profile().user_agent, mcc: '72' } };
      expect(profileViolations(broken)).toContain('user_agent.mcc must be three digits');
    });

    it('rejects a phone_id that is not a v4 UUID', () => {
      const broken = { ...profile(), user_agent: { ...profile().user_agent, phone_id: 'not-a-uuid' } };
      expect(profileViolations(broken)).toContain('user_agent.phone_id must be a v4 UUID');
    });

    it('rejects a profile that is not an object', () => {
      expect(profileViolations(null)).toEqual(['profile is not an object']);
    });
  });
});

describe('NumbersService device profile', () => {
  const build = (rows: unknown[]) => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
    const db = { query };
    const service = new NumbersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, db, query };
  };

  it('returns null for a line without a profile, which keeps the Waxum defaults', async () => {
    const { service } = build([{ device_profile: null }]);
    await expect(service.deviceProfile('t1', 'n1')).resolves.toBeNull();
  });

  it('returns the frozen profile of a line', async () => {
    const { service } = build([{ device_profile: profile() }]);
    await expect(service.deviceProfile('t1', 'n1')).resolves.toEqual(profile());
  });

  it('returns null instead of sending an incoherent profile', async () => {
    const broken = { ...profile(), user_agent: { ...profile().user_agent, mcc: '72' } };
    const { service } = build([{ device_profile: broken }]);
    await expect(service.deviceProfile('t1', 'n1')).resolves.toBeNull();
  });

  it('keeps the profile a line already has instead of rewriting it', async () => {
    const { service, query } = build([{ device_profile: profile() }]);
    const result = await service.freezeDeviceProfile('t1', 'n1', { geelarkPhoneId: 'phone-1', androidVersion: 'Android 14', phoneId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    expect(result).toEqual(profile());
    const updates = query.mock.calls.filter((call) => String(call[0]).includes('UPDATE whatsapp_numbers SET geelark_phone_id'));
    expect(updates).toHaveLength(0);
  });
});
