import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSingleFlight } from './useSingleFlight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useSingleFlight', () => {
  it('mantem somente uma requisicao pendente por chave', async () => {
    const gate = deferred<number>();
    const task = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useSingleFlight());

    const first = result.current('dashboard', task);
    const second = result.current('dashboard', task);

    expect(second).toBe(first);
    expect(task).toHaveBeenCalledTimes(1);
    gate.resolve(42);
    await expect(first).resolves.toBe(42);
  });

  it('libera a chave depois que a requisicao termina', async () => {
    const task = vi.fn(async () => 'ok');
    const { result } = renderHook(() => useSingleFlight());

    await act(async () => { await result.current('metrics', task); });
    await act(async () => { await result.current('metrics', task); });

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('nao mistura requisicoes de filtros diferentes', async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstTask = vi.fn(() => firstGate.promise);
    const secondTask = vi.fn(() => secondGate.promise);
    const { result } = renderHook(() => useSingleFlight());

    const first = result.current('tenant-a', firstTask);
    const second = result.current('tenant-b', secondTask);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).toHaveBeenCalledTimes(1);
    firstGate.resolve(); secondGate.resolve();
    await Promise.all([first, second]);
  });
});
