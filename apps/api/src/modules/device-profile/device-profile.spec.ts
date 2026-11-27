import { mapMultiloginPhone, type MultiloginPhone } from '../../infrastructure/multilogin/multilogin.client';
import { generateStealthProfile, profileIdentity } from '../stealth/stealth-profile';
import { BRAZIL_CARRIERS, buildDeviceProfile, deviceProfileState, lineIdentity, parseDeviceProfile } from './device-profile';

const PHONE_ID = '5f0c2b8e-3a1d-4c55-9a0e-2f6b7c1d9e10';
const phone: MultiloginPhone = { id: '647956853220704390', name: 'Previtas 30', androidVersion: '14', brand: 'samsung', model: 'SM-A546E', hasSim: false };
const profile = buildDeviceProfile(phone, PHONE_ID);
const android = { os_version: '14', manufacturer: 'samsung', device: 'SM-A546E', mcc: '000', mnc: '000', phone_id: PHONE_ID };
const newCamouflage = { device: { os: 'Android', platform: 'android_phone' }, client_profile: { locale: 'pt_BR', android } };

describe('device profile (docs/device-profile.md)', () => {
  afterEach(() => { delete process.env.DEVICE_PROFILE_KILLSWITCH; });

  it('copies the cloud phone; without a SIM it has no carrier', () => {
    expect(profile).toEqual({ version: 1, surface: 'ANDROID_PHONE', source: { multilogin_phone_id: phone.id, name: 'Previtas 30' }, android, client: { locale: 'pt_BR' } });
  });

  it('gives a phone with a SIM a Brazilian carrier, always the same for that phone', () => {
    const withSim = { ...phone, hasSim: true };
    const first = buildDeviceProfile(withSim, PHONE_ID).android;
    expect(first.mcc).toBe('724');
    expect(BRAZIL_CARRIERS.map((carrier) => carrier.mnc)).toContain(first.mnc);
    expect(buildDeviceProfile(withSim).android.mnc).toBe(first.mnc);
  });

  it('generates a new phone_id per copy', () => {
    expect(buildDeviceProfile(phone).android.phone_id).not.toBe(buildDeviceProfile(phone).android.phone_id);
  });

  it('refuses a stored profile it does not build', () => {
    expect(parseDeviceProfile(profile)).toEqual(profile);
    expect(() => parseDeviceProfile({ ...profile, android: { ...android, phone_id: 'per-login' } })).toThrow('phone_id');
    expect(() => parseDeviceProfile({ ...profile, android: { ...android, mnc: '' } })).toThrow('operadora');
    expect(() => parseDeviceProfile({ ...profile, surface: 'WEB' })).toThrow('superfície');
  });

  describe('lineIdentity', () => {
    const stealth = generateStealthProfile('line-1');
    const frozen = '2026-11-27T10:00:00Z';

    it('leaves a line that never chose it exactly as today', () => {
      expect(lineIdentity({}, false)).toBeUndefined();
      expect(lineIdentity({}, true)).toBeUndefined();
      const stealthLine = { stealth_enabled: true, stealth_profile: stealth, stealth_profile_frozen_at: frozen };
      expect(lineIdentity(stealthLine, false)).toEqual(profileIdentity(stealth));
      expect(lineIdentity(stealthLine, true)).toEqual(profileIdentity(stealth));
    });

    it('waits for a pairing once chosen', () => {
      const chosen = { device_profile_enabled: true, device_profile_active: false, device_profile: profile, device_profile_frozen_at: frozen };
      expect(lineIdentity(chosen, false)).toEqual({ client_profile: { reset: true } });
      expect(lineIdentity(chosen, true)).toEqual(newCamouflage);
    });

    it('keeps the profile on reconnects once paired with it, and drops it at the next pairing after turning it off', () => {
      const active = { device_profile_enabled: true, device_profile_active: true, device_profile: profile, device_profile_frozen_at: frozen };
      expect(lineIdentity(active, false)).toEqual(newCamouflage);
      const leaving = { ...active, device_profile_enabled: false };
      expect(lineIdentity(leaving, false)).toEqual(newCamouflage);
      expect(lineIdentity(leaving, true)).toEqual({ client_profile: { reset: true } });
    });

    it('goes back to the browser camouflage the line had, forgetting the Android profile first', () => {
      const line = { stealth_enabled: true, stealth_profile: stealth, stealth_profile_frozen_at: frozen, device_profile_enabled: false, device_profile_active: false, device_profile: profile, device_profile_frozen_at: frozen };
      const today = profileIdentity(stealth);
      expect(lineIdentity(line, true)).toEqual({ ...today, client_profile: { ...today.client_profile, reset: true } });
    });

    it('drops it everywhere with the killswitch', () => {
      process.env.DEVICE_PROFILE_KILLSWITCH = 'true';
      const active = { device_profile_enabled: true, device_profile_active: true, device_profile: profile, device_profile_frozen_at: frozen };
      expect(lineIdentity(active, false)).toEqual({ client_profile: { reset: true } });
      expect(lineIdentity(active, true)).toEqual({ client_profile: { reset: true } });
    });
  });

  it('tells the card whether the choice is waiting, in use or leaving', () => {
    expect(deviceProfileState({})).toBeNull();
    expect(deviceProfileState({ device_profile_enabled: true })).toBe('pending');
    expect(deviceProfileState({ device_profile_enabled: true, device_profile_active: true })).toBe('active');
    expect(deviceProfileState({ device_profile_enabled: false, device_profile_active: true })).toBe('leaving');
  });
});

describe('mapMultiloginPhone', () => {
  // The shape Multilogin answered on 2026-11-27.
  const raw = {
    id: '647956853220704390',
    serial_name: 'Previtas 19 - 77 92169-3165',
    equipment_info: { device_brand: 'OPPO', device_model: 'Find X8 Pro', os_version: 'Android 16', enable_sim: 0, net_type: 0 },
  };

  it('reads the brand, model, Android version and SIM of the phone', () => {
    expect(mapMultiloginPhone(raw)).toEqual({ id: '647956853220704390', name: 'Previtas 19 - 77 92169-3165', androidVersion: '16', brand: 'OPPO', model: 'Find X8 Pro', hasSim: false });
    expect(mapMultiloginPhone({ ...raw, equipment_info: { ...raw.equipment_info, enable_sim: 1 } })?.hasSim).toBe(true);
  });

  it('leaves out a phone that cannot give a line its identity', () => {
    expect(mapMultiloginPhone({ ...raw, equipment_info: { os_version: 'Android 16' } })).toBeNull();
  });
});
