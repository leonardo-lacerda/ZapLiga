import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelCommand, StationSnapshot } from '../shared/types';
import { PANEL_PORT } from '../shared/types';

/** Live view of the offscreen station, plus a way to send it commands. */
export function useStation() {
  const [state, setState] = useState<StationSnapshot | null>(null);
  const [lost, setLost] = useState(false);
  const port = useRef<any>(null);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    const connect = async () => {
      try {
        const ready = await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
        if (!ready?.ok) throw new Error(ready?.error ?? 'offscreen');
        const next = chrome.runtime.connect({ name: PANEL_PORT });
        port.current = next;
        setLost(false);
        next.onMessage.addListener((snapshot: StationSnapshot) => setState(snapshot));
        next.onDisconnect.addListener(() => { port.current = null; if (!closed) { setLost(true); retry = window.setTimeout(() => void connect(), 1000); } });
      } catch {
        if (!closed) { setLost(true); retry = window.setTimeout(() => void connect(), 2000); }
      }
    };
    void connect();
    return () => { closed = true; if (retry) window.clearTimeout(retry); port.current?.disconnect(); };
  }, []);

  const send = useCallback((command: PanelCommand) => { port.current?.postMessage(command); }, []);
  return { state, lost, send };
}
