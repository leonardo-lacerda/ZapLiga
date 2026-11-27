/**
 * The device profile a line presents in the WhatsApp handshake (docs/device-profile.md).
 *
 * A line registered on a GeeLark cloud phone keeps that phone's identity: the profile is
 * written once, when the number is linked to the phone, and is never rewritten. Every
 * reconnection of the same line therefore presents the same device, which is what a real
 * phone does — the profile is part of the account, not of the connection.
 *
 * The shape mirrors the fields the client sends in its handshake. Only values the ZapLiga
 * actually knows are filled: the phone's Android version and the line's own identifiers.
 * Anything else stays null and the Waxum keeps its environment default for that field, so a
 * line without a profile behaves exactly as it did before this existed.
 */

/** What the client declares it is. Android is what the account was registered on. */
export type DeviceSurface = 'ANDROID_PHONE' | 'ANDROID_TABLET' | 'WEB';

export type DeviceUserAgent = {
  platform: 'ANDROID' | 'WEB';
  mcc: string;
  mnc: string;
  os_version: string;
  manufacturer: string | null;
  device: string | null;
  os_build_number: string | null;
  /** Stable per installation: generated once and reused on every reconnection. */
  phone_id: string;
  release_channel: 'RELEASE';
  locale_language: string;
  locale_country: string;
  device_board: string | null;
  /** Derived from the cloud phone, so reinstalling the line keeps the same value. */
  device_exp_id: string | null;
  device_type: 'PHONE' | 'TABLET';
  device_model_type: string | null;
  distribution_channel: string | null;
};

export type DeviceProps = {
  os: 'Android';
  platform_type: 'ANDROID_PHONE' | 'ANDROID_TABLET';
  version: string | null;
};

export type DeviceProfile = {
  version: 1;
  surface: DeviceSurface;
  user_agent: DeviceUserAgent;
  device_props: DeviceProps;
  /** Only a Web surface fills this; an Android surface leaves it null. */
  web_info: { browser: string; browser_version: string } | null;
};

/** Brazilian mobile network codes, used when the phone does not report its carrier. */
const DEFAULT_MCC = '724';
const DEFAULT_MNC = '06';
const DEFAULT_LOCALE_LANGUAGE = 'pt';
const DEFAULT_LOCALE_COUNTRY = 'BR';

/** "Android 14" -> "14"; anything unparsable falls back to the newest version GeeLark offers. */
export function androidVersionNumber(value: unknown): string {
  const match = /(\d{1,2})/.exec(String(value ?? ''));
  return match ? match[1] : '14';
}

/**
 * Deterministic UUID (v5-shaped) from a seed, so the same cloud phone always yields the same
 * value. Node's crypto has no nameUUIDFromBytes, so the hash is built here.
 */
export function stableUuid(seed: string): string {
  // FNV-1a over the seed, expanded to 16 bytes with a second pass over a different offset.
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < seed.length; index += 1) {
      h ^= seed.charCodeAt(index) + pass * 31;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let index = 0; index < 8; index += 1) {
      bytes[pass * 8 + index] = (h >>> (index * 4)) & 0xff;
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ProfileInput = {
  /** The GeeLark cloud phone the line was registered on. */
  geelarkPhoneId: string;
  /** "Android 14", as chosen when the phone was created. */
  androidVersion: string;
  /** Generated once per line; the caller persists it. */
  phoneId: string;
  surface?: DeviceSurface;
  mcc?: string | null;
  mnc?: string | null;
  manufacturer?: string | null;
  device?: string | null;
  localeLanguage?: string | null;
  localeCountry?: string | null;
};

/**
 * Builds the frozen profile for a line. Every field is either the phone's own value or an
 * explicit fallback; nothing is invented beyond what the plan documents.
 */
export function buildDeviceProfile(input: ProfileInput): DeviceProfile {
  const surface = input.surface ?? 'ANDROID_PHONE';
  const osVersion = androidVersionNumber(input.androidVersion);
  const mcc = (input.mcc ?? '').trim() || DEFAULT_MCC;
  const mnc = (input.mnc ?? '').trim() || DEFAULT_MNC;

  return {
    version: 1,
    surface,
    user_agent: {
      platform: surface === 'WEB' ? 'WEB' : 'ANDROID',
      mcc: mcc.padStart(3, '0').slice(-3),
      mnc: mnc.padStart(3, '0').slice(-3),
      os_version: osVersion,
      manufacturer: input.manufacturer ?? null,
      device: input.device ?? null,
      os_build_number: null,
      phone_id: input.phoneId,
      release_channel: 'RELEASE',
      locale_language: (input.localeLanguage ?? DEFAULT_LOCALE_LANGUAGE).toLowerCase(),
      locale_country: (input.localeCountry ?? DEFAULT_LOCALE_COUNTRY).toUpperCase(),
      device_board: null,
      device_exp_id: stableUuid(input.geelarkPhoneId),
      device_type: surface === 'ANDROID_TABLET' ? 'TABLET' : 'PHONE',
      device_model_type: null,
      distribution_channel: null,
    },
    device_props: {
      os: 'Android',
      platform_type: surface === 'ANDROID_TABLET' ? 'ANDROID_TABLET' : 'ANDROID_PHONE',
      version: null,
    },
    web_info: surface === 'WEB' ? { browser: 'Chrome', browser_version: '120' } : null,
  };
}

export type ProfileViolation = string;

/**
 * The coherence rules a stored profile must satisfy. A profile that fails any of them is
 * rejected on read rather than sent, so a bad row cannot reach the handshake.
 */
export function profileViolations(profile: unknown): ProfileViolation[] {
  const problems: ProfileViolation[] = [];
  const value = profile as Partial<DeviceProfile> | null;
  if (!value || typeof value !== 'object') return ['profile is not an object'];
  if (value.version !== 1) problems.push('version must be 1');

  const ua = value.user_agent as Partial<DeviceUserAgent> | undefined;
  if (!ua) {
    problems.push('user_agent missing');
    return problems;
  }
  if (!/^\d{3}$/.test(String(ua.mcc ?? ''))) problems.push('user_agent.mcc must be three digits');
  if (!/^\d{3}$/.test(String(ua.mnc ?? ''))) problems.push('user_agent.mnc must be three digits');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(ua.phone_id ?? ''))) {
    problems.push('user_agent.phone_id must be a v4 UUID');
  }
  if (!/^[a-z]{2}$/.test(String(ua.locale_language ?? ''))) problems.push('user_agent.locale_language must be two lowercase letters');
  if (!/^[A-Z]{2}$/.test(String(ua.locale_country ?? ''))) problems.push('user_agent.locale_country must be two uppercase letters');

  const isWeb = value.surface === 'WEB';
  if (isWeb) {
    if (ua.platform !== 'WEB') problems.push('a WEB surface must declare platform WEB');
    if (!value.web_info) problems.push('a WEB surface must carry web_info');
  } else {
    if (ua.platform !== 'ANDROID') problems.push('an Android surface must declare platform ANDROID');
    if (value.web_info) problems.push('an Android surface must not carry web_info');
    if (!value.device_props) problems.push('an Android surface must carry device_props');
  }
  return problems;
}
