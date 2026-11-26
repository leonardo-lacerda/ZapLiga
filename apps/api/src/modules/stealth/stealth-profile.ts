import { createHash } from 'node:crypto';
import type { SessionIdentity } from '../../infrastructure/waxum/session-identity';

/**
 * Camouflage profile of a line (docs/stealth-profile.md): opt-in per line, generated once and
 * frozen. Only what WA Web itself varies:
 * - registration (`DeviceProps`, sent when the line pairs): WA Web registers either a browser
 *   (CHROME/EDGE/FIREFOX/SAFARI, no full history sync) or the Windows app (UWP plus a 365-day
 *   sync); lines take the browser row;
 * - login (`ClientPayload.UserAgent`, every login): the locale. The rest stays the library's web
 *   profile: WA Web sends mcc/mnc "000" and WIFI_UNKNOWN and never a `phone_id`, and a per-login
 *   `phone_id` made the server invalidate sessions (whatsapp-rust wacore/src/store/device.rs).
 */
export type StealthPlatform = 'chrome' | 'edge' | 'firefox' | 'safari';
export type StealthOs = 'Windows' | 'Mac OS';
export type StealthProfileV1 = {
  version: 1;
  surface: 'WEB_BROWSER';
  device: { os: StealthOs; platform: StealthPlatform };
  client: { locale: typeof STEALTH_LOCALE };
};
export type StealthCoverage = 'FULL' | 'PARTIAL';

// Desktop browser shares in Brazil, rounded; they add up to 100.
export const STEALTH_PLATFORM_WEIGHTS: ReadonlyArray<{ platform: StealthPlatform; weight: number }> = [
  { platform: 'chrome', weight: 78 },
  { platform: 'edge', weight: 12 },
  { platform: 'firefox', weight: 5 },
  { platform: 'safari', weight: 5 },
];
// Out of 100 Chrome, Edge and Firefox lines, how many run on a Mac. Safari is always a Mac.
export const STEALTH_MAC_SHARE = 8;
// Every line is a +55 number, so every line logs in as Brazilian Portuguese.
export const STEALTH_LOCALE = 'pt_BR';

const PLATFORMS = new Set<string>(STEALTH_PLATFORM_WEIGHTS.map((entry) => entry.platform));

/** The same seed (the line id) always gives the same profile. */
export function generateStealthProfile(seed: string): StealthProfileV1 {
  const hash = createHash('sha256').update(seed).digest();
  let roll = hash.readUInt32BE(0) % 100;
  const platform = STEALTH_PLATFORM_WEIGHTS.find((entry) => (roll -= entry.weight) < 0)?.platform ?? 'chrome';
  const onMac = platform === 'safari' || hash.readUInt32BE(4) % 100 < STEALTH_MAC_SHARE;
  return { version: 1, surface: 'WEB_BROWSER', device: { os: onMac ? 'Mac OS' : 'Windows', platform }, client: { locale: STEALTH_LOCALE } };
}

/** A stored profile, refused when it is not one this code generates (unknown version, incoherent pair). */
export function parseStealthProfile(value: unknown): StealthProfileV1 {
  const profile = value as Partial<StealthProfileV1> | null;
  const fail = (reason: string): never => { throw new Error(`Perfil de camuflagem inválido: ${reason}`); };
  if (!profile || typeof profile !== 'object') return fail('ausente');
  if (profile.version !== 1) return fail(`versão ${String(profile.version)}`);
  if (profile.surface !== 'WEB_BROWSER') return fail(`superfície ${String(profile.surface)}`);
  const platform = profile.device?.platform;
  const os = profile.device?.os;
  if (!platform || !PLATFORMS.has(platform)) return fail(`plataforma ${String(platform)}`);
  if (os !== 'Windows' && os !== 'Mac OS') return fail(`sistema ${String(os)}`);
  if (platform === 'safari' && os !== 'Mac OS') return fail('Safari fora do Mac');
  if (profile.client?.locale !== STEALTH_LOCALE) return fail(`idioma ${String(profile.client?.locale)}`);
  return { version: 1, surface: 'WEB_BROWSER', device: { os, platform }, client: { locale: STEALTH_LOCALE } };
}

export const STEALTH_ADMIN_ONLY_MESSAGE = 'Só o admin do ZapLiga liga a camuflagem de uma linha.';
export const STEALTH_KILLSWITCH_MESSAGE = 'A camuflagem está desligada para todas as linhas (STEALTH_KILLSWITCH).';

/** `STEALTH_KILLSWITCH=true`: every line behaves as if its switch were off, without touching the database. */
export function stealthKillswitchOn() {
  return process.env.STEALTH_KILLSWITCH === 'true';
}

/** The columns of `whatsapp_numbers` this module reads (migration 081). */
export type StealthLine = {
  stealth_enabled?: boolean | null;
  stealth_profile?: unknown;
  stealth_profile_frozen_at?: string | Date | null;
  last_paired_at?: string | Date | null;
  created_at?: string | Date | null;
};

/**
 * What the line's session requests carry. A line that never had the switch on sends nothing, so
 * its requests stay byte for byte what they were. One that had it on and has it off now (or the
 * killswitch) asks Waxum to forget the identity it saved.
 */
export function sessionIdentity(line: StealthLine): SessionIdentity | undefined {
  if (!line.stealth_profile_frozen_at) return undefined;
  if (!line.stealth_enabled || stealthKillswitchOn()) return { client_profile: { reset: true } };
  return profileIdentity(parseStealthProfile(line.stealth_profile));
}

export function profileIdentity(profile: StealthProfileV1): SessionIdentity {
  return { device: { os: profile.device.os, platform: profile.device.platform }, client_profile: { locale: profile.client.locale } };
}

/**
 * FULL when the line paired (or was created) after its profile was frozen, so WhatsApp registered
 * it with the profile's props; PARTIAL when only the login carries it until a new QR or code.
 */
export function stealthCoverage(line: StealthLine): StealthCoverage | null {
  if (!line.stealth_enabled || !line.stealth_profile_frozen_at) return null;
  const reference = line.last_paired_at ?? line.created_at;
  return reference && new Date(reference).getTime() >= new Date(line.stealth_profile_frozen_at).getTime() ? 'FULL' : 'PARTIAL';
}
