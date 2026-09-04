export type AudioDeviceOption = { deviceId: string; label: string; groupId: string };

/** Pseudo-devices Chrome lists ahead of the real ones; they alias whatever the OS default is. */
const PSEUDO_IDS = new Set(['default', 'communications']);

export const STORAGE_INPUT_KEY = 'zapliga.audio.inputDeviceId';
export const STORAGE_OUTPUT_KEY = 'zapliga.audio.outputDeviceId';

export function isPseudoDevice(deviceId: string) {
  return PSEUDO_IDS.has(deviceId);
}

export function describeDevice(device: AudioDeviceOption, index: number, kind: 'input' | 'output') {
  if (device.label) return device.label;
  return kind === 'input' ? `Microfone ${index + 1}` : `Saída ${index + 1}`;
}

export function toDeviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind): AudioDeviceOption[] {
  return devices
    .filter((device) => device.kind === kind && device.deviceId)
    .map((device) => ({ deviceId: device.deviceId, label: device.label, groupId: device.groupId }));
}

/**
 * The output endpoint that belongs to the same physical device as the microphone in use.
 *
 * This is what makes a Bluetooth headset work: opening its microphone switches it to the
 * Hands-Free profile, and while that profile is up the "Stereo" endpoint the OS lists as default
 * goes mute. The Hands-Free input and Hands-Free output share a `groupId`, so following it puts
 * playback on the one endpoint that is actually producing sound. Real device ids win over the
 * `default`/`communications` aliases, which point at the muted endpoint in exactly that case.
 * Returns '' (system default) when nothing matches.
 */
export function pickOutputForInput(outputs: AudioDeviceOption[], inputs: AudioDeviceOption[], activeInputId: string): string {
  if (!activeInputId) return '';
  const input = inputs.find((device) => device.deviceId === activeInputId);
  if (!input?.groupId) return '';
  const siblings = outputs.filter((device) => device.groupId === input.groupId);
  if (!siblings.length) return '';
  const real = siblings.filter((device) => !isPseudoDevice(device.deviceId));
  if (!real.length) return siblings[0].deviceId;
  // Windows may give every endpoint of one Bluetooth headset the same groupId, Stereo and
  // Hands-Free alike. The one that actually plays while the headset microphone is open is the
  // Hands-Free endpoint, so tie-break on the label: exact match with the microphone's own label
  // first, then any Hands-Free/Headset endpoint, then whatever is left.
  const inputLabel = normalizeDeviceLabel(input.label);
  const exact = inputLabel ? real.find((device) => normalizeDeviceLabel(device.label) === inputLabel) : undefined;
  const handsFree = HANDS_FREE_PATTERN.test(inputLabel) ? real.find((device) => HANDS_FREE_PATTERN.test(normalizeDeviceLabel(device.label))) : undefined;
  return (exact ?? handsFree ?? real[0]).deviceId;
}

const HANDS_FREE_PATTERN = /hands-?free|headset|hfp/i;

/** Strip the "Default - " / "Communications - " (and pt-BR) prefixes Chrome prepends to alias devices. */
export function normalizeDeviceLabel(label: string) {
  return label.replace(/^(default|communications|padr[aã]o|comunica[cç][oõ]es)\s*[-–]\s*/i, '').trim().toLowerCase();
}

/** A stored selection is only worth applying while that device is still plugged in. */
export function resolveStoredSelection(stored: string, devices: AudioDeviceOption[]) {
  if (!stored) return '';
  return devices.some((device) => device.deviceId === stored) ? stored : '';
}

export function readStoredDevice(key: string) {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function writeStoredDevice(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch { /* storage may be unavailable (private mode); the choice still applies to this session */ }
}
