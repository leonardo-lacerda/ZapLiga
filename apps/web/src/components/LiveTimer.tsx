import { useEffect, useState } from 'react';

function secondsSince(value: unknown) {
  const timestamp = new Date(String(value ?? '')).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 1000)) : 0;
}

export function formatDuration(value: unknown) {
  const total = Math.max(0, Number(value) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LiveTimer({ startedAt, initialSeconds = 0, className = '' }: { startedAt?: unknown; initialSeconds?: number; className?: string }) {
  const [elapsed, setElapsed] = useState(() => startedAt ? secondsSince(startedAt) : Number(initialSeconds) || 0);
  useEffect(() => {
    const update = () => setElapsed(startedAt ? secondsSince(startedAt) : Number(initialSeconds) || 0);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, initialSeconds]);
  return <span className={className}>{formatDuration(elapsed)}</span>;
}
