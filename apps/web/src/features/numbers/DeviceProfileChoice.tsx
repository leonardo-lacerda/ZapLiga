import { useEffect, useState } from 'react';
import { json } from '../../services/api';
import type { AnyRow } from '../../types';
import { Badge, Button, Icon } from '../../components/ui';
import {
  DEVICE_PROFILE_HINT, DEVICE_PROFILE_LABEL, DEVICE_PROFILE_OPTION_NEW, DEVICE_PROFILE_OPTION_TODAY,
  DEVICE_PROFILE_PHONE_LABEL, DEVICE_PROFILE_PHONE_PLACEHOLDER, DEVICE_PROFILE_STATE_COPY,
} from './deviceProfile.copy';

export type MultiloginPhone = { id: string; name: string; androidVersion: string; brand: string; model: string; takenBy: string | null };

const phoneLabel = (phone: MultiloginPhone) => `${phone.name} · ${phone.brand} ${phone.model} · Android ${phone.androidVersion}`;

/** The Multilogin cloud phones, loaded only when `enabled` (the admin is choosing one). */
export function useMultiloginPhones(enabled: boolean) {
  const [phones, setPhones] = useState<MultiloginPhone[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || phones) return;
    json('/api/multilogin/phones')
      .then((result: { items: MultiloginPhone[] }) => setPhones(result.items))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [enabled, phones]);
  return { phones, error };
}

/** Picker of the cloud phone a number was registered on; phones another line took are shown, disabled. */
export function MultiloginPhoneSelect({ value, onChange, phones, disabled = false }: { value: string; onChange: (id: string) => void; phones: MultiloginPhone[] | null; disabled?: boolean }) {
  return <select aria-label={DEVICE_PROFILE_PHONE_LABEL} value={value} disabled={disabled || !phones} onChange={(event) => onChange(event.target.value)}>
    <option value="">{phones ? DEVICE_PROFILE_PHONE_PLACEHOLDER : 'Carregando celulares...'}</option>
    {phones?.map((phone) => <option key={phone.id} value={phone.id} disabled={Boolean(phone.takenBy)}>{phoneLabel(phone)}{phone.takenBy ? ` (usado por ${phone.takenBy})` : ''}</option>)}
  </select>;
}

/**
 * The line's camouflage, chosen by the ZapLiga admin: as it is today, or the new camouflage (#5)
 * as a Multilogin cloud phone. The choice only takes effect at the line's next QR or code.
 */
export function DeviceProfileChoice({ number, canManage }: { number: AnyRow; canManage: boolean }) {
  const [line, setLine] = useState<AnyRow>(number);
  const [mode, setMode] = useState<'today' | 'new'>(number.device_profile_enabled ? 'new' : 'today');
  const [phoneId, setPhoneId] = useState<string>(number.multilogin_phone_id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A line paired with its phone keeps it: changing phones needs "Como está hoje" and a new pairing first.
  const phoneLocked = Boolean(line.device_profile_active);
  const { phones, error: phonesError } = useMultiloginPhones(canManage && mode === 'new' && !phoneLocked);
  if (!canManage) return null;

  const enabled = mode === 'new';
  const dirty = enabled !== Boolean(line.device_profile_enabled) || (enabled && phoneId !== (line.multilogin_phone_id ?? ''));
  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = enabled && phoneId !== (line.multilogin_phone_id ?? '') ? { enabled, multiloginPhoneId: phoneId } : { enabled };
      setLine(await json(`/api/numbers/${number.id}/device-profile`, { method: 'PATCH', body: JSON.stringify(body) }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  const state = DEVICE_PROFILE_STATE_COPY[line.device_profile_state ?? ''];
  const android = line.device_profile?.android;

  return <>
    <label className={`admin-flag-row${dirty ? ' is-dirty' : ''}`}>
      <span>{DEVICE_PROFILE_LABEL}<small>{DEVICE_PROFILE_HINT}</small></span>
      <select aria-label={DEVICE_PROFILE_LABEL} value={mode} disabled={saving} onChange={(event) => setMode(event.target.value as 'today' | 'new')}>
        <option value="today">{DEVICE_PROFILE_OPTION_TODAY}</option>
        <option value="new">{DEVICE_PROFILE_OPTION_NEW}</option>
      </select>
    </label>
    {enabled && !phoneLocked && <MultiloginPhoneSelect value={phoneId} onChange={setPhoneId} phones={phones} disabled={saving} />}
    {dirty && <Button variant="secondary" type="button" disabled={saving || (enabled && !phoneId)} onClick={() => void save()}>{saving ? 'Salvando...' : 'Salvar camuflagem'}</Button>}
    {state && <div className="resource-meta"><span>Nova camuflagem</span><Badge tone={state.tone}>{state.label}</Badge></div>}
    {state && android && <div className="resource-meta"><span>Celular</span><strong>{android.manufacturer} {android.device} · Android {android.os_version} · {android.mcc}/{android.mnc}</strong></div>}
    {(error || phonesError) && <div className="alert" role="alert"><Icon name="alert" /><span>{error || phonesError}</span></div>}
  </>;
}
