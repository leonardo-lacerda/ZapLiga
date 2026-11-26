import { STEALTH_MAC_SHARE, STEALTH_PLATFORM_WEIGHTS, generateStealthProfile, parseStealthProfile, sessionIdentity, stealthCoverage } from './stealth-profile';

const SEEDS = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);

describe('generateStealthProfile', () => {
  it('always gives the same profile for the same line', () => {
    expect(generateStealthProfile('line-1')).toEqual(generateStealthProfile('line-1'));
  });

  it('only generates profiles WA Web itself could send', () => {
    for (const seed of SEEDS) {
      const profile = generateStealthProfile(seed);
      expect(parseStealthProfile(profile)).toEqual(profile);
      expect(profile.surface).toBe('WEB_BROWSER');
      expect(profile.client.locale).toBe('pt_BR');
      if (profile.device.platform === 'safari') expect(profile.device.os).toBe('Mac OS');
    }
  });

  it('spreads the lines over the browsers by their weights', () => {
    const profiles = SEEDS.map(generateStealthProfile);
    for (const { platform, weight } of STEALTH_PLATFORM_WEIGHTS) {
      const share = (profiles.filter((profile) => profile.device.platform === platform).length / profiles.length) * 100;
      expect(Math.abs(share - weight)).toBeLessThan(2);
    }
    const others = profiles.filter((profile) => profile.device.platform !== 'safari');
    const macShare = (others.filter((profile) => profile.device.os === 'Mac OS').length / others.length) * 100;
    expect(Math.abs(macShare - STEALTH_MAC_SHARE)).toBeLessThan(2);
  });
});

describe('parseStealthProfile', () => {
  const valid = generateStealthProfile('line-1');

  it.each([
    ['a missing profile', null],
    ['another version', { ...valid, version: 2 }],
    ['the Windows app surface', { ...valid, surface: 'DESKTOP_APP' }],
    ['a platform WA Web does not register', { ...valid, device: { os: 'Windows', platform: 'desktop' } }],
    ['Safari off a Mac', { ...valid, device: { os: 'Windows', platform: 'safari' } }],
    ['another locale', { ...valid, client: { locale: 'en_US' } }],
  ])('refuses %s', (_case, profile) => {
    expect(() => parseStealthProfile(profile)).toThrow('Perfil de camuflagem inválido');
  });
});

describe('sessionIdentity', () => {
  const profile = { version: 1, surface: 'WEB_BROWSER', device: { os: 'Windows', platform: 'edge' }, client: { locale: 'pt_BR' } };
  const frozenAt = '2026-11-26T12:00:00Z';
  afterEach(() => { delete process.env.STEALTH_KILLSWITCH; });

  it('sends nothing for a line that never had the switch on', () => {
    expect(sessionIdentity({ stealth_enabled: false, stealth_profile: null, stealth_profile_frozen_at: null })).toBeUndefined();
  });

  it('sends the registration props and the login locale, and nothing else', () => {
    const identity = sessionIdentity({ stealth_enabled: true, stealth_profile: profile, stealth_profile_frozen_at: frozenAt });

    expect(identity).toEqual({ device: { os: 'Windows', platform: 'edge' }, client_profile: { locale: 'pt_BR' } });
  });

  it('asks Waxum to forget the identity once the switch is off', () => {
    expect(sessionIdentity({ stealth_enabled: false, stealth_profile: profile, stealth_profile_frozen_at: frozenAt })).toEqual({ client_profile: { reset: true } });
  });

  it('turns every line off with the killswitch, without touching the line', () => {
    process.env.STEALTH_KILLSWITCH = 'true';

    expect(sessionIdentity({ stealth_enabled: true, stealth_profile: profile, stealth_profile_frozen_at: frozenAt })).toEqual({ client_profile: { reset: true } });
  });
});

describe('stealthCoverage', () => {
  const frozenAt = '2026-11-26T12:00:00Z';

  it('is FULL for a line paired after its profile was frozen', () => {
    expect(stealthCoverage({ stealth_enabled: true, stealth_profile_frozen_at: frozenAt, last_paired_at: '2026-11-26T12:05:00Z' })).toBe('FULL');
  });

  it('is FULL for a line created with the switch on and not paired yet', () => {
    expect(stealthCoverage({ stealth_enabled: true, stealth_profile_frozen_at: frozenAt, created_at: frozenAt, last_paired_at: null })).toBe('FULL');
  });

  it('is PARTIAL for a line paired before the switch went on', () => {
    expect(stealthCoverage({ stealth_enabled: true, stealth_profile_frozen_at: frozenAt, created_at: '2026-11-01T00:00:00Z', last_paired_at: '2026-11-20T00:00:00Z' })).toBe('PARTIAL');
  });

  it('is nothing for a line with the switch off', () => {
    expect(stealthCoverage({ stealth_enabled: false, stealth_profile_frozen_at: frozenAt, last_paired_at: '2026-11-26T12:05:00Z' })).toBeNull();
  });
});
