export const statusNames: Record<string, string> = {
  queued: 'Na fila',
  retry_wait: 'Aguardando retry',
  reserved: 'Reservada',
  dialing: 'Discando',
  media_active: 'Em chamada',
  connected: 'Conectado',
  disconnected: 'Desconectado',
  completed: 'Concluída',
  no_answer: 'Não atendeu',
  failed: 'Falhou',
  online: 'Online',
  ready: 'Pronto',
  authenticated: 'Autenticado',
};

export const labelStatus = (value: unknown) => statusNames[String(value)] ?? String(value ?? '—');

export const formatSeconds = (value: unknown) => {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds <= 0) return 'Livre';
  if (seconds < 60) return `${seconds}s restantes`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}min${remainder ? ` ${remainder}s` : ''} restantes`;
};

export const formatNextAttempt = (value: unknown) => {
  if (!value) return 'agora';
  const date = new Date(String(value));
  if (date.getTime() <= Date.now()) return 'agora';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

