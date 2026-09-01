import { useCallback, useEffect, useRef, useState } from 'react';
import { json, wsUrl } from '../../services/api';
import type { AnyRow } from '../../types';

export type OperationsConnection = 'connecting' | 'connected' | 'fallback' | 'offline';

type OperationsActivity = AnyRow | null;

export type OperationsRealtimeResult = {
  snapshot: AnyRow | null;
  connection: OperationsConnection;
  error: string;
  activity: OperationsActivity;
  refresh: () => Promise<void>;
};

const nextReconnectDelay = (attempt: number) => Math.min(15_000, 1000 * 2 ** Math.min(4, Math.max(0, attempt - 1)));

export function useOperationsRealtime(tenantId: string, enabled = true): OperationsRealtimeResult {
  const [snapshot, setSnapshot] = useState<AnyRow | null>(null);
  const [connection, setConnection] = useState<OperationsConnection>('offline');
  const [error, setError] = useState('');
  const [activity, setActivity] = useState<OperationsActivity>(null);
  const socket = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number>();
  const refreshTimer = useRef<number>();
  const activityTimer = useRef<number>();
  const reconnectAttempt = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !tenantId) return;
    try {
      const next = await json('/api/dialer/operations');
      setSnapshot(next);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a operação');
      setConnection((current) => current === 'connected' ? current : 'fallback');
    }
  }, [enabled, tenantId]);

  useEffect(() => {
    let disposed = false;
    reconnectAttempt.current = 0;
    setSnapshot(null);
    setActivity(null);
    setError('');
    setConnection(enabled && tenantId ? 'connecting' : 'offline');

    const clearTimers = () => {
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      if (activityTimer.current) window.clearTimeout(activityTimer.current);
      reconnectTimer.current = undefined;
      refreshTimer.current = undefined;
      activityTimer.current = undefined;
    };

    const scheduleSnapshotRefresh = (nextActivity: OperationsActivity) => {
      if (nextActivity) {
        setActivity(nextActivity);
        if (activityTimer.current) window.clearTimeout(activityTimer.current);
        activityTimer.current = window.setTimeout(() => setActivity(null), 6000);
      }
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        void refresh();
      }, 150);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer.current) return;
      reconnectAttempt.current += 1;
      setConnection('fallback');
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = undefined;
        void connect();
      }, nextReconnectDelay(reconnectAttempt.current));
    };

    const connect = async () => {
      if (disposed || !enabled || !tenantId) return;
      setConnection('connecting');
      const ticketResult = await json('/api/auth/operations-ws-ticket', { method: 'POST' }).catch(() => null);
      if (disposed || !ticketResult?.ticket) {
        void refresh();
        scheduleReconnect();
        return;
      }

      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(`${wsUrl()}/ws/tenants/${encodeURIComponent(tenantId)}/operations?ticket=${encodeURIComponent(ticketResult.ticket)}`);
      } catch {
        scheduleReconnect();
        return;
      }
      socket.current = nextSocket;
      nextSocket.onopen = () => {
        if (disposed || socket.current !== nextSocket) return;
        reconnectAttempt.current = 0;
        setConnection('connected');
        setError('');
      };
      nextSocket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'operations_snapshot') {
            setSnapshot(message.snapshot ?? null);
            setConnection('connected');
            setError('');
          } else if (message.type === 'operations_changed') {
            scheduleSnapshotRefresh(message.activity ?? null);
          }
        } catch {
          setError('O canal de operação enviou uma atualização inválida');
        }
      };
      nextSocket.onerror = () => {
        if (socket.current === nextSocket) setError('Canal de operação instável. Tentando reconectar…');
      };
      nextSocket.onclose = () => {
        if (socket.current !== nextSocket || disposed) return;
        socket.current = null;
        scheduleSnapshotRefresh(null);
        scheduleReconnect();
      };
    };

    if (enabled && tenantId) {
      void refresh();
      void connect();
    }
    const fallbackTimer = enabled && tenantId ? window.setInterval(() => {
      if (socket.current?.readyState !== WebSocket.OPEN) void refresh();
    }, 15_000) : undefined;

    return () => {
      disposed = true;
      clearTimers();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
      const current = socket.current;
      socket.current = null;
      if (current) {
        current.onclose = null;
        current.close();
      }
    };
  }, [enabled, refresh, tenantId]);

  return { snapshot, connection, error, activity, refresh };
}
