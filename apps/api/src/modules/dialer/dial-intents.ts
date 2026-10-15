/**
 * Dial intents let a CRM integration pre-authorize one manual call for one of
 * its linked agents. The intent is redeemed by the agent's own station socket
 * (message `dial`), on whichever API instance holds that socket -- the
 * server-to-server request that created it may have landed on another one.
 */
export const DIAL_INTENT_TTL_SECONDS = 60;
export const dialIntentKey = (intentId: string) => `zapcall:dial-intent:${intentId}`;

export type DialIntent = {
  id: string;
  tenantId: string;
  integrationId: string;
  sdrId: string;
  numberId: string;
  phone: string;
  name: string;
  externalRef: Record<string, string | number> | null;
  leadExternalId: string | null;
  createdAt: string;
};

/** A refusal the CRM can act on (pick another line, retry later, reconnect the station). */
export class DialRefusedError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

const MAX_REF_KEYS = 12;
const MAX_REF_VALUE_LENGTH = 200;

/**
 * The CRM's own identifiers for the call (account, contact, lead, conversation, its call id...).
 * Stored as-is and echoed back on every event, so keep it small and flat.
 */
export function sanitizeExternalRef(value: unknown): Record<string, string | number> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new DialRefusedError('invalid_external_ref', 'external_ref deve ser um objeto');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_REF_KEYS) throw new DialRefusedError('invalid_external_ref', `external_ref aceita no máximo ${MAX_REF_KEYS} campos`);
  const result: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key)) throw new DialRefusedError('invalid_external_ref', `Campo inválido em external_ref: ${key.slice(0, 40)}`);
    if (item == null) continue;
    if (typeof item === 'number' && Number.isFinite(item)) { result[key] = item; continue; }
    if (typeof item !== 'string' || item.length > MAX_REF_VALUE_LENGTH) throw new DialRefusedError('invalid_external_ref', `external_ref.${key} deve ser texto curto ou número`);
    result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}
