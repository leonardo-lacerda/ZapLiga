import { useEffect, useRef, type MutableRefObject } from 'react';
import { AudioBridge } from './AudioBridge';

/**
 * One AudioBridge for the lifetime of the component that owns it.
 *
 * The obvious `useRef(new AudioBridge())` is a trap: React evaluates the
 * argument on EVERY render and keeps only the first, so each re-render built
 * a throwaway bridge whose constructor had already registered a global
 * `devicechange` listener on navigator.mediaDevices. That listener pinned the
 * discarded instance forever. The leader dashboard re-renders at least every
 * 5 s (status polling), so a tab left open accumulated thousands of bridges,
 * and one Bluetooth headset event made all of them enumerate devices at once
 * -- the browser eventually killed the tab with "Out of Memory".
 */
export function useAudioBridge(): MutableRefObject<AudioBridge> {
  const ref = useRef<AudioBridge | null>(null);
  if (ref.current === null) ref.current = new AudioBridge();
  useEffect(() => {
    const bridge = ref.current;
    return () => { if (bridge) void bridge.dispose(); };
  }, []);
  return ref as MutableRefObject<AudioBridge>;
}
