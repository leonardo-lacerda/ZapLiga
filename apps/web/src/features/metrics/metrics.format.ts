import { formatDuration } from '../../components/LiveTimer';
import { formatNumber } from '../../shared/format';

export const formatPercent = (value: number) => `${value}%`;
export const formatSecondsShort = formatDuration;
export { formatNumber };

export const formatDateTime = (value: string | null) => {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const formatBucketLabel = (bucket: string, granularity: 'hour' | 'day' | 'week') => {
  const date = new Date(bucket);
  if (granularity === 'hour') return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
};

export const formatRemainingSeconds = (seconds: number) => {
  if (seconds <= 0) return 'Livre';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}min${rest ? ` ${rest}s` : ''}` : `${rest}s`;
};
