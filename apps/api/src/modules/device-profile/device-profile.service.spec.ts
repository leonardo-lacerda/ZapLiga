import { DeviceProfileService } from './device-profile.service';

const android = { os_version: '16', manufacturer: 'OPPO', device: 'Find X8 Pro', mcc: '000', mnc: '000', phone_id: '5f0c2b8e-3a1d-4c55-9a0e-2f6b7c1d9e10', business: false };
const deviceProfile = { version: 1, surface: 'ANDROID_PHONE', source: { multilogin_phone_id: 'ml-1', name: 'Previtas 22' }, android, client: { locale: 'pt_BR' } };

describe('DeviceProfileService.setChoice (docs/device-profile.md)', () => {
  const make = (line: Record<string, unknown>) => {
    const db = { query: jest.fn(async (sql: string, params: unknown[]) => (sql.startsWith('SELECT') ? { rows: [line] } : { rows: [{ ...line, device_profile: params[3] ? JSON.parse(String(params[3])) : line.device_profile }] })) };
    const multilogin = { getPhone: jest.fn(async () => ({ id: 'ml-2', name: 'Previtas 23', androidVersion: '16', brand: 'OPPO', model: 'Find X8 Pro', hasSim: false })), listPhones: jest.fn() };
    const service = new DeviceProfileService(db as any, { record: jest.fn(async () => undefined) } as any, { assertAction: jest.fn(async () => undefined) } as any, multilogin as any);
    return { service, db };
  };
  const chosen = { id: 'n1', device_profile_enabled: true, device_profile_active: false, multilogin_phone_id: 'ml-1', device_profile: deviceProfile };

  it('switches a line not paired with the profile to WhatsApp Business, keeping the phone and phone_id', async () => {
    const { service, db } = make(chosen);

    const row = await service.setChoice('t1', 'u1', 'n1', true, undefined, true);

    const saved = JSON.parse(String(db.query.mock.calls[1][1][3]));
    expect(saved.android).toEqual({ ...android, business: true });
    expect(row.device_profile_state).toBe('pending');
  });

  it('refuses to change the app of a line paired with the profile', async () => {
    const { service } = make({ ...chosen, device_profile_active: true });

    await expect(service.setChoice('t1', 'u1', 'n1', true, undefined, true)).rejects.toThrow('pareie de novo');
  });

  it('asks for the app when a phone is chosen', async () => {
    const { service } = make({ id: 'n2', device_profile_enabled: false, device_profile_active: false, multilogin_phone_id: null, device_profile: null });

    await expect(service.setChoice('t1', 'u1', 'n2', true, 'ml-2')).rejects.toThrow('WhatsApp Business');
  });

  it('copies a new phone as WhatsApp Business', async () => {
    const { service, db } = make({ id: 'n2', device_profile_enabled: false, device_profile_active: false, multilogin_phone_id: null, device_profile: null });
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('WHERE multilogin_phone_id = $1')) return { rows: [] };
      if (sql.startsWith('SELECT')) return { rows: [{ id: 'n2', device_profile_active: false, multilogin_phone_id: null, device_profile: null }] };
      return { rows: [{ id: 'n2', device_profile_enabled: true, device_profile_active: false, device_profile: JSON.parse(String(params[3])) }] };
    });

    const row = await service.setChoice('t1', 'u1', 'n2', true, 'ml-2', true);

    expect(row.device_profile.android.business).toBe(true);
    expect(row.device_profile.source.multilogin_phone_id).toBe('ml-2');
  });
});
