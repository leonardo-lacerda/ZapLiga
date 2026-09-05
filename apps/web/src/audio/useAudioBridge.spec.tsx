import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioBridge } from './AudioBridge';
import { useAudioBridge } from './useAudioBridge';

// jsdom has no navigator.mediaDevices; give the bridge a global to register on so
// the test can count how many listeners survive across renders and unmount.
const listeners = new Set<EventListener>();
const mediaDevices = {
  addEventListener: vi.fn((_type: string, handler: EventListener) => { listeners.add(handler); }),
  removeEventListener: vi.fn((_type: string, handler: EventListener) => { listeners.delete(handler); }),
  enumerateDevices: vi.fn(async () => []),
};

beforeEach(() => {
  listeners.clear();
  mediaDevices.addEventListener.mockClear();
  mediaDevices.removeEventListener.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
});
afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('useAudioBridge', () => {
  it('cria uma unica ponte por componente, mesmo com muitas renderizacoes', () => {
    const { result, rerender } = renderHook(() => useAudioBridge());
    const first = result.current.current;
    for (let index = 0; index < 25; index += 1) rerender();

    expect(result.current.current).toBe(first);
    // The leak: one global devicechange listener per render. Now it is one, full stop.
    expect(mediaDevices.addEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
  });

  it('remove o ouvinte global quando o componente desmonta', () => {
    const { unmount } = renderHook(() => useAudioBridge());
    expect(listeners.size).toBe(1);

    unmount();

    expect(mediaDevices.removeEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

describe('AudioBridge.dispose', () => {
  it('desregistra exatamente o ouvinte que o construtor registrou', async () => {
    const bridge = new AudioBridge();
    const other = new AudioBridge();
    expect(listeners.size).toBe(2);

    await bridge.dispose();

    expect(listeners.size).toBe(1);
    await other.dispose();
    expect(listeners.size).toBe(0);
  });
});
