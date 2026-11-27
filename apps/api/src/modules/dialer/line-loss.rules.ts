/**
 * Why WhatsApp took a line away (or held it back), read from the Waxum events that say so.
 *
 * A companion device never goes through WhatsApp's registration flow, so what reaches it is the
 * connection's own language: a `<failure>` code (401 logout, 402 temporary ban, 403 account lock,
 * 405/409 a refused client, 500/503 a server hiccup), a `<stream:error>` conflict (device removed,
 * replaced) and the call server's nack 463 (reachout timelock). Waxum v10 publishes each of them by
 * name (infra/waxum/patches/waxum-zapliga-loss.patch); older images still send the two losses the
 * API always knew, which this reads the same way.
 */
export const LINE_LOSS_CAUSES = [
  'device_removed',
  'account_locked',
  'temp_banned',
  'reachout_timelock',
  'logged_out_other',
  'client_rejected',
  'transient',
  'media_failure',
  'unknown',
  'registration',
] as const;
export type LineLossCause = typeof LINE_LOSS_CAUSES[number];

/** Causes that take a line out until an operator acts (a new QR, or the phone). */
export const LINE_OUT_CAUSES: ReadonlySet<LineLossCause> = new Set<LineLossCause>(['device_removed', 'account_locked']);

/** What the phone shows when WhatsApp refuses its registration; recorded by hand (migration 082). */
export const REGISTRATION_REASONS = [
  'blocked',
  'temporarily_unavailable',
  'limited_release',
  'not_allowed',
  'reset_too_soon',
  'too_many_guesses',
  'guessed_too_fast',
  'stale',
] as const;
export type RegistrationReason = typeof REGISTRATION_REASONS[number];

export function isRegistrationReason(value: unknown): value is RegistrationReason {
  return typeof value === 'string' && (REGISTRATION_REASONS as readonly string[]).includes(value);
}

/** The Waxum events that can carry a cause. */
export const LINE_LOSS_EVENT_TYPES = ['account_locked', 'logged_out', 'temp_banned', 'connect_failure', 'stream_error', 'call_ack'] as const;

export interface LineLossSignal {
  cause: LineLossCause;
  sourceEvent: string;
  code: string | null;
  violationType: string | null;
  violationReason: string | null;
  expiresAt: Date | null;
  detail: Record<string, unknown>;
}

/** The call server's nack when the account may not reach new people for now. */
export const REACHOUT_TIMELOCK_NACK = '463';
/** `<stream:error code="515">` is the routine restart right after pairing, not a problem. */
const ROUTINE_STREAM_ERRORS: ReadonlySet<string> = new Set(['515']);
const CLIENT_REJECTED_CODES: ReadonlySet<number> = new Set([405, 409, 413, 414, 418]);
const TRANSIENT_CODES: ReadonlySet<number> = new Set([500, 503]);

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function signal(cause: LineLossCause, sourceEvent: string, detail: Record<string, unknown>, extra: Partial<LineLossSignal> = {}): LineLossSignal {
  return { cause, sourceEvent, code: null, violationType: null, violationReason: null, expiresAt: null, detail, ...extra };
}

/** The cause a Waxum event states, or null when the event says nothing about the line's health. */
export function classifyLineLoss(type: string, payload: unknown, now: Date = new Date()): LineLossSignal | null {
  const data = objectOf(objectOf(payload).data);
  switch (type) {
    case 'account_locked': {
      const details = objectOf(data.details);
      return signal('account_locked', type, data, {
        code: textOf(details.reason) ?? '403',
        violationType: textOf(details.violation_type) ?? textOf(details.vt),
        violationReason: textOf(details.violation_reason) ?? textOf(details.violated_policy),
      });
    }
    case 'logged_out': {
      const conflict = textOf(data.conflict);
      if (conflict === 'device_removed') return signal('device_removed', type, data, { code: conflict });
      if (conflict) return signal('transient', type, data, { code: conflict });
      const reason = textOf(data.reason);
      if (!reason) return null;
      if (reason === 'LoggedOut' || reason === 'UnknownLogout') return signal('logged_out_other', type, data, { code: reason });
      if (reason === 'ClientOutdated' || reason === 'BadUserAgent') return signal('client_rejected', type, data, { code: reason });
      return signal('unknown', type, data, { code: reason });
    }
    case 'temp_banned': {
      const seconds = numberOf(data.expire_secs);
      return signal('temp_banned', type, data, {
        code: textOf(data.code),
        expiresAt: seconds && seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null,
      });
    }
    case 'connect_failure': {
      const code = numberOf(data.code);
      if (code === null) return null;
      if (code === 402) return signal('temp_banned', type, data, { code: String(code) });
      if (code === 403) return signal('account_locked', type, data, { code: String(code) });
      if (CLIENT_REJECTED_CODES.has(code)) return signal('client_rejected', type, data, { code: String(code) });
      if (TRANSIENT_CODES.has(code)) return signal('transient', type, data, { code: String(code) });
      return signal('unknown', type, data, { code: String(code) });
    }
    case 'stream_error': {
      const code = textOf(data.code);
      if (!code || ROUTINE_STREAM_ERRORS.has(code)) return null;
      return signal('transient', type, data, { code });
    }
    case 'call_ack':
      return textOf(data.error) === REACHOUT_TIMELOCK_NACK ? signal('reachout_timelock', type, data, { code: REACHOUT_TIMELOCK_NACK }) : null;
    default:
      return null;
  }
}

/**
 * One id per event, shared by both API instances (each gets every NATS event), so the insert of
 * the second one is a no-op: session, event, the event's own timestamp (seconds) and its code.
 */
export function lineLossEventId(sessionId: string, type: string, payload: unknown, code: string | null, receivedAt: Date = new Date()): string {
  const stamp = numberOf(objectOf(payload).timestamp) ?? Math.floor(receivedAt.getTime() / 1000);
  return `${sessionId}:${type}:${stamp}:${code ?? ''}`;
}

/** A short pause for a call that died without audio and without the server saying why (was 6 h). */
export const MEDIA_FAILURE_PAUSE_MINUTES = 30;
/** A temporary ban without a stated duration: wait a day rather than guess shorter. */
export const TEMP_BAN_FALLBACK_HOURS = 24;
/** A reachout timelock whose end the server did not state: the quarantine the dialer always used. */
export const REACHOUT_FALLBACK_HOURS = 6;

/**
 * Until when a cause stops a line from dialing, or null when it does not. `statedEnd` is what the
 * server said (a ban's `expire`, a timelock's `time_enforcement_ends`); without it, a fallback.
 */
export function dialBlockUntil(cause: LineLossCause, statedEnd: Date | null, now: Date = new Date()): Date | null {
  const stated = statedEnd && statedEnd.getTime() > now.getTime() ? statedEnd : null;
  switch (cause) {
    case 'temp_banned':
      return stated ?? new Date(now.getTime() + TEMP_BAN_FALLBACK_HOURS * 3_600_000);
    case 'reachout_timelock':
      return stated ?? new Date(now.getTime() + REACHOUT_FALLBACK_HOURS * 3_600_000);
    case 'media_failure':
      return new Date(now.getTime() + MEDIA_FAILURE_PAUSE_MINUTES * 60_000);
    default:
      return null;
  }
}

/**
 * The end of an active reachout timelock in Waxum's answer (`GET /sessions/{id}/reachout-timelock`:
 * `is_active`, `time_enforcement_ends`), or null when none is active or the end is unreadable.
 * The end comes as epoch seconds, epoch milliseconds or an ISO date.
 */
export function reachoutTimelockEnd(state: unknown, now: Date = new Date()): Date | null {
  const body = objectOf(state);
  if (body.is_active !== true) return null;
  const raw = body.time_enforcement_ends;
  const numeric = numberOf(raw);
  const end = numeric !== null ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : typeof raw === 'string' ? new Date(raw) : null;
  return end && Number.isFinite(end.getTime()) && end.getTime() > now.getTime() ? end : null;
}

/** SQL over a `whatsapp_numbers` alias: no cause is holding the line back from dialing now. */
export function lineDialAllowedSql(alias: string) {
  return `(${alias}.dial_blocked_until IS NULL OR ${alias}.dial_blocked_until <= now())`;
}

/** Whether the per-cause policy is on for a tenant: LINE_LOSS_POLICY=v2, optionally only for LINE_LOSS_POLICY_TENANTS. */
export function lineLossPolicyEnabled(tenantId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LINE_LOSS_POLICY !== 'v2') return false;
  const tenants = (env.LINE_LOSS_POLICY_TENANTS ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  return tenants.length === 0 || tenants.includes(tenantId);
}

/** What the operator should do, per cause, in the line's card. */
export const LINE_LOSS_ACTIONS: Record<LineLossCause, string> = {
  device_removed: 'Removida pelo WhatsApp: descansar e conectar por QR novo',
  account_locked: 'Conta bloqueada: resolver no celular antes de qualquer QR',
  temp_banned: 'Banimento temporário: esperar o prazo, sem reconectar',
  reachout_timelock: 'Limite de alcance do WhatsApp: esperar o prazo para discar',
  logged_out_other: 'Desconectada pelo WhatsApp: conectar por QR novo',
  client_rejected: 'Recusa técnica do WhatsApp: avisar o suporte',
  transient: 'Oscilação: reconecta sozinha',
  media_failure: 'Ligação sem áudio: pausa curta',
  unknown: 'Causa não reconhecida: ver detalhe',
  registration: 'Recusa no registro do celular',
};
