export const PAGE_SIZE = 25;

export const formatNumber = (value: unknown) => new Intl.NumberFormat('pt-BR').format(Number(value ?? 0));

export const statusNames: Record<string, string> = {
  queued: 'Na fila', retry_wait: 'Aguardando retry', reserved: 'Reservada', dialing: 'Discando', media_active: 'Em chamada',
  connected: 'Conectado', disconnected: 'Desconectado', completed: 'Concluída', no_answer: 'Não atendeu', failed: 'Falhou',
  online: 'Online', ready: 'Pronto', authenticated: 'Autenticado', offline: 'Offline', available: 'Disponível', in_call: 'Em chamada',
  post_call: 'Pós-atendimento', paused: 'Pausado', cancelled: 'Cancelada', manual: 'Discagem manual',
};

export const labelStatus = (value: unknown) => statusNames[String(value)] ?? String(value ?? '—');

const callReasonNames: Record<string, string> = {
  ring_timeout: 'Tempo de toque esgotado', waxum_closed: 'Waxum encerrou a conexão antes do atendimento', remote_hangup: 'Cliente encerrou a chamada',
  sdr_hangup: 'SDR encerrou a chamada', browser_disconnected: 'Navegador do SDR desconectou', sdr_disconnected: 'SDR desconectou',
  browser_error: 'Erro no navegador do SDR', microphone_denied: 'Permissão do microfone negada', api_restarted: 'API reiniciou durante a chamada',
  waxum_rate_limited: 'Waxum temporariamente ocupado; tentativa devolvida à fila', waxum_closed_before_answer: 'Waxum encerrou antes do atendimento',
};

export const formatCallReason = (value: unknown) => {
  const reason = String(value ?? '').trim();
  if (!reason) return '—';
  if (reason.startsWith('waxum_recipient_error:')) return `Destinatário não preparado pelo Waxum: ${reason.slice('waxum_recipient_error:'.length)}`;
  if (reason.startsWith('waxum_error:')) return `Erro no Waxum: ${reason.slice('waxum_error:'.length)}`;
  if (reason.startsWith('waxum_http_error:')) return `Waxum recusou a conexão (HTTP ${reason.slice('waxum_http_error:'.length)})`;
  if (reason.startsWith('waxum_closed:')) { const [, code, detail] = reason.split(':', 3); return `Waxum encerrou antes do atendimento${code ? ` (código ${code}${detail ? `: ${detail}` : ''})` : ''}`; }
  return callReasonNames[reason] ?? reason.replaceAll('_', ' ');
};

export const callResultOptions = [
  ['interessado', 'Interessado'],
  ['sem_interesse', 'Sem interesse'],
  ['retornar', 'Solicitou retorno'],
  ['reuniao_agendada', 'Reunião agendada'],
  ['numero_invalido', 'Número inválido'],
] as const;

export const pipelineStageOptions = [
  ['novo', 'Novo'],
  ['contatado', 'Contatado'],
  ['qualificado', 'Qualificado'],
  ['reuniao', 'Reunião'],
  ['ganho', 'Ganho'],
  ['perdido', 'Perdido'],
] as const;

const callResultNames: Record<string, string> = Object.fromEntries(callResultOptions);
const pipelineStageNames: Record<string, string> = Object.fromEntries(pipelineStageOptions);
export const formatCallResult = (value: unknown) => value ? (callResultNames[String(value)] ?? String(value)) : '—';
export const formatPipelineStage = (value: unknown) => value ? (pipelineStageNames[String(value)] ?? String(value)) : '—';

export const callStatusOptions = [
  ['completed', 'Concluída'],
  ['no_answer', 'Não atendeu'],
  ['failed', 'Falhou'],
  ['cancelled', 'Cancelada'],
] as const;

export const formatSeconds = (value: unknown) => {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds <= 0) return 'Livre';
  if (seconds < 60) return `${seconds}s restantes`;
  const minutes = Math.floor(seconds / 60); const remainder = seconds % 60;
  return `${minutes}min${remainder ? ` ${remainder}s` : ''} restantes`;
};

export const formatNextAttempt = (value: unknown) => {
  if (!value) return 'agora';
  const date = new Date(String(value));
  if (date.getTime() <= Date.now()) return 'agora';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
