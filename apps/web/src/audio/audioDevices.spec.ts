import { describe, expect, it } from 'vitest';
import { describeDevice, pickOutputForInput, resolveStoredSelection, toDeviceOptions } from './audioDevices';

const bluetoothInputs = [
  { deviceId: 'default', label: 'Default - Headset (FAM A068N Hands-Free AG Audio)', groupId: 'bt-hfp' },
  { deviceId: 'communications', label: 'Communications - Headset (FAM A068N Hands-Free AG Audio)', groupId: 'bt-hfp' },
  { deviceId: 'mic-hfp', label: 'Headset (FAM A068N Hands-Free AG Audio)', groupId: 'bt-hfp' },
  { deviceId: 'mic-usb', label: 'Microphone (Logi USB Headset)', groupId: 'usb' },
];
const bluetoothOutputs = [
  { deviceId: 'default', label: 'Default - Headphones (FAM A068N Stereo)', groupId: 'bt-a2dp' },
  { deviceId: 'communications', label: 'Communications - Headset (FAM A068N Hands-Free AG Audio)', groupId: 'bt-hfp' },
  { deviceId: 'out-a2dp', label: 'Headphones (FAM A068N Stereo)', groupId: 'bt-a2dp' },
  { deviceId: 'out-hfp', label: 'Headset (FAM A068N Hands-Free AG Audio)', groupId: 'bt-hfp' },
  { deviceId: 'out-usb', label: 'Speakers (Logi USB Headset)', groupId: 'usb' },
];

describe('pickOutputForInput', () => {
  it('follows a Bluetooth microphone to the Hands-Free output of the same headset, not the muted Stereo default', () => {
    // The OS default output is the A2DP "Stereo" endpoint, which goes silent while the Hands-Free
    // microphone is open. The sibling that shares the microphone's groupId is the one that plays.
    expect(pickOutputForInput(bluetoothOutputs, bluetoothInputs, 'mic-hfp')).toBe('out-hfp');
  });

  it('prefers the real device id over the communications alias for the same group', () => {
    expect(pickOutputForInput(bluetoothOutputs, bluetoothInputs, 'mic-hfp')).not.toBe('communications');
  });

  it('pairs a wired USB headset with its own speakers', () => {
    expect(pickOutputForInput(bluetoothOutputs, bluetoothInputs, 'mic-usb')).toBe('out-usb');
  });

  it('falls back to the system default when the microphone has no output sibling', () => {
    const inputs = [{ deviceId: 'webcam-mic', label: 'Webcam mic', groupId: 'webcam' }];
    expect(pickOutputForInput(bluetoothOutputs, inputs, 'webcam-mic')).toBe('');
  });

  it('falls back to the system default when no microphone is active', () => {
    expect(pickOutputForInput(bluetoothOutputs, bluetoothInputs, '')).toBe('');
  });
});

describe('resolveStoredSelection', () => {
  it('keeps a stored device that is still present and drops one that was unplugged', () => {
    expect(resolveStoredSelection('out-usb', bluetoothOutputs)).toBe('out-usb');
    expect(resolveStoredSelection('out-gone', bluetoothOutputs)).toBe('');
    expect(resolveStoredSelection('', bluetoothOutputs)).toBe('');
  });
});

describe('device listing', () => {
  it('maps only the requested kind and names unlabeled devices by position', () => {
    const raw = [
      { deviceId: 'a', kind: 'audioinput', label: '', groupId: 'g1' },
      { deviceId: 'b', kind: 'audiooutput', label: 'Speakers', groupId: 'g1' },
      { deviceId: '', kind: 'audiooutput', label: 'ghost', groupId: 'g2' },
    ] as MediaDeviceInfo[];
    const inputs = toDeviceOptions(raw, 'audioinput');
    const outputs = toDeviceOptions(raw, 'audiooutput');
    expect(inputs).toEqual([{ deviceId: 'a', label: '', groupId: 'g1' }]);
    expect(outputs).toEqual([{ deviceId: 'b', label: 'Speakers', groupId: 'g1' }]);
    expect(describeDevice(inputs[0], 0, 'input')).toBe('Microfone 1');
    expect(describeDevice(outputs[0], 0, 'output')).toBe('Speakers');
  });
});
