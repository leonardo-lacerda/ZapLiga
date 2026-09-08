import { useCallback, useEffect, useRef } from 'react';

/**
 * Coalesces concurrent executions for the same logical request.
 *
 * Polling must stay bounded when a request is slower than its interval. Without
 * this guard every tick retains another fetch, response buffer and component
 * closure until the network eventually settles.
 */
export function useSingleFlight() {
  const flights = useRef<Map<string, Promise<unknown>> | null>(null);
  if (flights.current === null) flights.current = new Map();

  useEffect(() => () => { flights.current?.clear(); }, []);

  return useCallback(function runSingleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
    const active = flights.current;
    if (!active) return task();
    const existing = active.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const flight = (async () => task())().finally(() => {
      if (active.get(key) === flight) active.delete(key);
    });
    active.set(key, flight);
    return flight;
  }, []);
}
