import { createHash, randomUUID } from 'node:crypto';
import type { MultiloginPhone } from '../../infrastructure/multilogin/multilogin.client';
import type { SessionIdentity } from '../../infrastructure/waxum/session-identity';
import { sessionIdentity, type StealthLine } from '../stealth/stealth-profile';

/**
 * New camouflage per line (docs/device-profile.md): the line logs in as the Android phone it was
 * registered on, a Multilogin cloud phone, linked as a second phone of the account. Opt-in per
 * line and frozen; it only takes effect when the line pairs, so a connected line keeps running
 * exactly as it does until its next QR or code.
 *
 * - registration (`DeviceProps`, at pairing): an Android phone;
 * - login (`ClientPayload.UserAgent`, every login): WhatsApp or WhatsApp Business as the account is
 *   (a Business account refuses a second phone that is not Business), the phone's Android version,
 *   brand, model and carrier, pt-BR, and a `phone_id` fixed for the line. The library warns that a `phone_id` that
 *   changes per login gets sessions dropped; this one never changes.
 */
export type DeviceProfileV1 = {
  version: 1;
  surface: 'ANDROID_PHONE';
  source: { multilogin_phone_id: string; name: string };
  android: { os_version: string; manufacturer: string; device: string; mcc: string; mnc: string; phone_id: string; business: boolean };
  client: { locale: typeof DEVICE_PROFILE_LOCALE };
};
/** `pending`: chosen, waiting for the next pairing. `active`: the line paired with it. */
export type DeviceProfileState = 'pending' | 'active' | 'leaving';

// Every line is a +55 number, so every line logs in as Brazilian Portuguese.
export const DEVICE_PROFILE_LOCALE = 'pt_BR';
const BRAZIL_MCC = '724';
// What an Android phone without a SIM sends, like WA Web: no carrier.
const NO_CARRIER = { mcc: '000', mnc: '000' };
// Carriers by mobile market share in Brazil, rounded, for a phone with a SIM: Multilogin does not say which.
export const BRAZIL_CARRIERS: ReadonlyArray<{ name: string; mnc: string; weight: number }> = [
  { name: 'Vivo', mnc: '06', weight: 39 },
  { name: 'Claro', mnc: '05', weight: 34 },
  { name: 'TIM', mnc: '02', weight: 27 },
];

export const DEVICE_PROFILE_ADMIN_ONLY_MESSAGE = 'Só o admin do ZapLiga escolhe a nova camuflagem de uma linha.';
export const DEVICE_PROFILE_KILLSWITCH_MESSAGE = 'A nova camuflagem está desligada para todas as linhas (DEVICE_PROFILE_KILLSWITCH).';

/** `DEVICE_PROFILE_KILLSWITCH=true`: every line behaves as if it never had the new camouflage. */
export function deviceProfileKillswitchOn() {
  return process.env.DEVICE_PROFILE_KILLSWITCH === 'true';
}

/** No SIM, no carrier. A phone with a SIM always gets the same Brazilian carrier. */
function carrierFor(phone: MultiloginPhone) {
  if (!phone.hasSim) return NO_CARRIER;
  let roll = createHash('sha256').update(phone.id).digest().readUInt32BE(0) % 100;
  const carrier = BRAZIL_CARRIERS.find((entry) => (roll -= entry.weight) < 0) ?? BRAZIL_CARRIERS[0];
  return { mcc: BRAZIL_MCC, mnc: carrier.mnc };
}

/** Copies the cloud phone once; `phone_id` is generated here and never again for the line. */
export function buildDeviceProfile(phone: MultiloginPhone, business: boolean, phoneId: string = randomUUID()): DeviceProfileV1 {
  return {
    version: 1,
    surface: 'ANDROID_PHONE',
    source: { multilogin_phone_id: phone.id, name: phone.name },
    android: { os_version: phone.androidVersion, manufacturer: phone.brand, device: phone.model, ...carrierFor(phone), phone_id: phoneId, business },
    client: { locale: DEVICE_PROFILE_LOCALE },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A stored profile, refused when it is not one this code builds. */
export function parseDeviceProfile(value: unknown): DeviceProfileV1 {
  const profile = value as Partial<DeviceProfileV1> | null;
  const fail = (reason: string): never => { throw new Error(`Perfil de dispositivo inválido: ${reason}`); };
  if (!profile || typeof profile !== 'object') return fail('ausente');
  if (profile.version !== 1) return fail(`versão ${String(profile.version)}`);
  if (profile.surface !== 'ANDROID_PHONE') return fail(`superfície ${String(profile.surface)}`);
  const android = profile.android;
  if (!android) return fail('sem dados do Android');
  if (!/^\d{1,2}$/.test(android.os_version)) return fail(`Android ${String(android.os_version)}`);
  if (!android.manufacturer?.trim() || !android.device?.trim()) return fail('sem marca ou modelo');
  if (!/^\d{3}$/.test(android.mcc) || !/^\d{2,3}$/.test(android.mnc)) return fail(`operadora ${String(android.mcc)}/${String(android.mnc)}`);
  if (!UUID.test(android.phone_id)) return fail('phone_id');
  if (typeof android.business !== 'boolean') return fail('sem o app (WhatsApp ou Business)');
  if (!profile.source?.multilogin_phone_id) return fail('sem celular de origem');
  if (profile.client?.locale !== DEVICE_PROFILE_LOCALE) return fail(`idioma ${String(profile.client?.locale)}`);
  return profile as DeviceProfileV1;
}

/** The columns of `whatsapp_numbers` this module reads (migrations 081 and 083). */
export type DeviceProfileLine = StealthLine & {
  device_profile_enabled?: boolean | null;
  device_profile_active?: boolean | null;
  device_profile?: unknown;
  device_profile_frozen_at?: string | Date | null;
};

/** Whether a request for this line carries the Android profile. A pairing takes the admin's choice. */
export function usesDeviceProfile(line: DeviceProfileLine, pairing: boolean) {
  if (!line.device_profile || deviceProfileKillswitchOn()) return false;
  return Boolean(pairing ? line.device_profile_enabled : line.device_profile_active);
}

/**
 * What the line's session requests carry. A line that never had the new camouflage sends what it
 * sends today (the camouflage of docs/stealth-profile.md or nothing), byte for byte. One that had
 * it and no longer uses it asks Waxum to forget the Android profile first.
 */
export function lineIdentity(line: DeviceProfileLine, pairing: boolean): SessionIdentity | undefined {
  if (usesDeviceProfile(line, pairing)) {
    const { android, client } = parseDeviceProfile(line.device_profile);
    return { device: { os: 'Android', platform: 'android_phone' }, client_profile: { locale: client.locale, android } };
  }
  const today = sessionIdentity(line);
  if (!line.device_profile_frozen_at) return today;
  return { ...today, client_profile: { ...today?.client_profile, reset: true } };
}

/** What the line card shows: chosen and waiting for a pairing, in use, or in use until the next pairing. */
export function deviceProfileState(line: DeviceProfileLine): DeviceProfileState | null {
  if (line.device_profile_active) return line.device_profile_enabled ? 'active' : 'leaving';
  return line.device_profile_enabled ? 'pending' : null;
}
