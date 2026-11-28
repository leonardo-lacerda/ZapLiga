// Regras da linha que a tela mostra (dialer.rules na API).
export const RETIRED_AFTER_LOSSES = 2;
export const YOUNG_LINE_DAILY_CALLS = 60;
export const LOSS_SUMMARY_DAYS = 30;

// Por que a linha caiu, nas palavras da operação (docs/line-loss-causes.md).
export const LOSS_CAUSE_LABEL: Record<string, string> = {
  device_removed: 'Removida',
  account_locked: 'Conta bloqueada',
  temp_banned: 'Banimento temporário',
  reachout_timelock: 'Limite de alcance',
  logged_out_other: 'Desconectada',
  client_rejected: 'Recusa técnica',
  transient: 'Oscilação',
  media_failure: 'Sem áudio',
  unknown: 'Outra causa',
  registration: 'Recusa no registro',
};

// O que fazer com a linha, por causa.
export const LOSS_CAUSE_ACTION: Record<string, string> = {
  device_removed: 'Removida pelo WhatsApp: descansar e conectar por QR novo',
  account_locked: 'Conta bloqueada: resolver no celular antes de qualquer QR',
  temp_banned: 'Banimento temporário: esperar o prazo, sem reconectar',
  reachout_timelock: 'Limite de alcance do WhatsApp: esperar o prazo para discar',
  logged_out_other: 'Desconectada pelo WhatsApp: conectar por QR novo',
  client_rejected: 'Recusa técnica do WhatsApp: avisar o suporte',
  transient: 'Oscilação: reconecta sozinha',
  media_failure: 'Ligação sem áudio: pausa curta',
  unknown: 'Causa não reconhecida',
  registration: 'Recusa no registro do celular',
};

// O que o celular mostra quando o WhatsApp recusa o registro, com a ação certa para cada um.
export const REGISTRATION_REASON_LABEL: Record<string, string> = {
  blocked: 'Bloqueado: apelar pelo celular',
  temporarily_unavailable: 'Indisponível no momento: esperar e tentar de novo',
  limited_release: 'Liberação limitada: não insistir',
  not_allowed: 'Não permitido: não insistir',
  reset_too_soon: 'Reset cedo demais: esperar',
  too_many_guesses: 'Código errado muitas vezes: parar de tentar',
  guessed_too_fast: 'Tentativas rápidas demais: esperar',
  stale: 'Código vencido: pedir outro',
};
