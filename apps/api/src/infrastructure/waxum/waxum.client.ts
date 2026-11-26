import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';
import WebSocket from 'ws';
import { DatabaseService } from '../../database/database.service';
import type { SessionIdentity } from './session-identity';

type WaxumSession = { id: string; name?: string; phone_number?: string; status?: string };

export const MAIN_WAXUM_NODE = 'main';
const SESSION_NODE_TTL_MS = 3000;

// `main` goes out through the VPS; WAXUM_EDGE_NODES (`edge-1=http://tailscale-edge-1:3451,…`)
// lists the Waxums that go out through an attendant's PC (docs/saida-pelo-pc-do-atendente.md).
export function waxumNodes() {
  const nodes = new Map([[MAIN_WAXUM_NODE, process.env.WAXUM_URL ?? 'http://localhost:3451']]);
  for (const entry of (process.env.WAXUM_EDGE_NODES ?? '').split(',').filter((item) => item.trim())) {
    const [name, url] = entry.split('=').map((part) => part.trim());
    if (!name || !url) throw new Error(`WAXUM_EDGE_NODES inválido: "${entry}"`);
    nodes.set(name, url);
  }
  return new Map([...nodes].map(([name, url]) => [name, url.replace(/\/$/, '')]));
}

@Injectable()
export class WaxumClient implements OnModuleDestroy {
  private readonly nodes = waxumNodes();
  // Which Waxum holds each session. Sessions move between Waxums (NumbersService.moveToWaxumNode),
  // possibly from the other API instance, so an entry only lives a few seconds.
  private readonly sessionNodes = new Map<string, { node: string; until: number }>();
  private readonly apiKey = process.env.WAXUM_API_KEY;
  private readonly natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
  private readonly requestIntervalMs = (() => {
    const configured = Number(process.env.WAXUM_REQUEST_INTERVAL_MS ?? 250);
    return Number.isFinite(configured) ? Math.max(0, configured) : 250;
  })();
  // Throttle independently per WhatsApp session. The previous global chain
  // made one busy tenant block QR/status/call operations for every tenant.
  private readonly requestChains = new Map<string, Promise<void>>();
  private readonly nextRequestAt = new Map<string, number>();
  private natsConnection?: Promise<NatsConnection>;

  constructor(private readonly db: DatabaseService) {}

  async onModuleDestroy() {
    const connection = await this.natsConnection?.catch(() => undefined);
    await connection?.drain();
  }

  private getNatsConnection() {
    this.natsConnection ??= connect({ servers: this.natsUrl, name: 'zapliga-api' });
    return this.natsConnection;
  }

  private headers() { return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }; }

  private nodeUrl(node: string) {
    const url = this.nodes.get(node);
    if (!url) throw new Error(`Waxum "${node}" não está configurado em WAXUM_EDGE_NODES`);
    return url;
  }

  private async sessionUrl(sessionId: string) {
    const cached = this.sessionNodes.get(sessionId);
    if (cached && cached.until > Date.now()) return this.nodeUrl(cached.node);
    const result = await this.db.query<{ waxum_node: string }>('SELECT waxum_node FROM whatsapp_numbers WHERE waxum_session_id = $1', [sessionId]);
    const node = result.rows[0]?.waxum_node;
    if (!node) throw new Error(`Sessão Waxum ${sessionId} não pertence a nenhum número`);
    this.rememberNode(sessionId, node);
    return this.nodeUrl(node);
  }

  private rememberNode(sessionId: string, node: string) {
    this.sessionNodes.set(sessionId, { node, until: Date.now() + SESSION_NODE_TTL_MS });
  }

  private request<T>(path: string, init: RequestInit = {}, maxAttempts = 3, node?: string): Promise<T> {
    const run = async () => {
      const sessionId = path.match(/\/sessions\/([^/]+)/)?.[1];
      const baseUrl = node ? this.nodeUrl(node) : await this.sessionUrl(decodeURIComponent(sessionId!));
      return this.requestWithRetry<T>(baseUrl, path, init, maxAttempts);
    };
    const key = this.queueKey(path);
    const previous = this.requestChains.get(key) ?? Promise.resolve();
    const queued = previous.then(run, run);
    const settled = queued.then(() => undefined, () => undefined);
    this.requestChains.set(key, settled);
    void settled.then(() => { if (this.requestChains.get(key) === settled) this.requestChains.delete(key); });
    return queued;
  }

  private queueKey(path: string) {
    const match = path.match(/\/sessions\/([^/]+)/);
    return match?.[1] ? `session:${decodeURIComponent(match[1])}` : 'control-plane';
  }

  private async waitForRequestSlot(key: string) {
    const now = Date.now();
    const next = this.nextRequestAt.get(key) ?? 0;
    const waitMs = Math.max(0, next - now);
    this.nextRequestAt.set(key, Math.max(now, next) + this.requestIntervalMs);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async requestWithRetry<T>(baseUrl: string, path: string, init: RequestInit, maxAttempts: number): Promise<T> {
    const queueKey = this.queueKey(path);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitForRequestSlot(queueKey);
      const response = await fetch(`${baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10000), headers: { ...this.headers(), ...(init.headers ?? {}) } });
      const body = await response.text();
      let parsed: any = body;
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* plain response */ }
      if (response.ok) return parsed as T;
      if ([502, 503, 504].includes(response.status) && attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 500 * (attempt + 1))));
        continue;
      }
      const error = new Error(`Waxum ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`) as Error & { statusCode?: number };
      error.statusCode = response.status;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds = Number(retryAfter);
      throw error;
    }
    throw new Error('Waxum request failed');
  }

  // `identity` (docs/stealth-profile.md) rides next to the request's own fields; without it the
  // bodies below are the ones Waxum always got.
  async createSession(name: string, node: string, identity?: SessionIdentity) {
    const { session } = await this.request<{ session: WaxumSession }>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ name, ...identity }) }, 3, node);
    this.rememberNode(session.id, node);
    return session;
  }

  /**
   * Moving a line between Waxums. Every Waxum mounts the same session storage
   * (docker-compose.yml), so the device keys stay put: the source lets go of the
   * session without logging out, and the target opens it from storage — no QR.
   */
  releaseSession(sessionId: string, node: string) {
    return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/disconnect`, { method: 'POST' }, 1, node);
  }

  async adoptSession(sessionId: string, name: string, node: string, identity?: SessionIdentity) {
    // `reuse` reconnects a session this Waxum already knows (it held the line before).
    const result = await this.request<any>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ id: sessionId, name, reuse: true, ...identity }) }, 1, node);
    this.rememberNode(sessionId, node);
    return result;
  }

  statusOn(sessionId: string, node: string) {
    return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, {}, 1, node);
  }
  async deleteSession(sessionId: string) {
    const result = await this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, 1);
    this.sessionNodes.delete(sessionId);
    return result;
  }
  // Links the line by typing an 8-character code on the phone instead of reading the QR.
  // Waxum waits up to 20 s for WhatsApp to hand out the code, hence the longer timeout.
  pairCode(sessionId: string, phone: string, identity?: SessionIdentity) {
    return this.request<{ code: string; timeout_seconds: number }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/pair`, { method: 'POST', body: JSON.stringify({ phone_number: phone, ...identity }), signal: AbortSignal.timeout(30000) }, 1);
  }
  // A plain WhatsApp text from the line to a phone (digits with country code).
  sendText(sessionId: string, phone: string, text: string) {
    return this.request<{ status: string; message_id?: string }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/text`, { method: 'POST', body: JSON.stringify({ to: phone.replace(/\D/g, ''), text }) }, 1);
  }

  /**
   * Session events of every line (`wa.events.<session>.<type>`, published by each Waxum).
   * Without `queue` every API instance receives every event, so each one can tell its own open
   * dashboards and handlers must make their writes idempotent; with it, one instance gets each.
   */
  async subscribeSessionEvents(types: string[], onEvent: (sessionId: string, type: string, payload: any) => Promise<void>, queue?: string) {
    const connection = await this.getNatsConnection();
    const codec = StringCodec();
    for (const type of types) {
      const subscription = connection.subscribe(`wa.events.*.${type}`, queue ? { queue } : undefined);
      void (async () => {
        for await (const message of subscription) {
          const sessionId = message.subject.split('.')[2];
          let payload: any = {};
          try { payload = JSON.parse(codec.decode(message.data)); } catch { /* not JSON: keep the empty payload */ }
          await onEvent(sessionId, type, payload).catch(() => undefined);
        }
      })();
    }
  }

  getQr(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/qr`); }
  getStatus(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, {}, 1); }
  disconnect(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/disconnect`, { method: 'POST' }, 1); }
  reconnect(sessionId: string, identity?: SessionIdentity) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/connect`, { method: 'POST', body: JSON.stringify({ ...identity }) }).catch((error: Error & { statusCode?: number }) => { if (error.statusCode === 409) return { already_connecting: true }; throw error; }); }
  // WhatsApp VoIP needs the callee's LID to derive media keys; a phone-number
  // JID (`<pn>@s.whatsapp.net`) is rejected with "no known LID for the PN
  // callee". A cold number's LID is not in the local store, but a usync
  // (`contacts/check`, which does NOT notify the callee) makes Waxum learn it.
  // check normalizes the number (e.g. drops the Brazilian 9th digit) and
  // returns the canonical JID under which the LID is then stored.
  async checkContact(sessionId: string, phone: string): Promise<{ jid: string; isRegistered: boolean } | null> {
    const digits = phone.replace(/\D/g, '');
    const res = await this.request<{ results?: Array<{ phone?: string; jid?: string; is_registered?: boolean }> }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/contacts/check`,
      { method: 'POST', body: JSON.stringify({ phones: [digits] }) },
      1,
    );
    const row = res.results?.[0];
    if (!row?.jid) return null;
    return { jid: row.jid, isRegistered: Boolean(row.is_registered) };
  }

  // Reads the LID that a prior usync stored for this contact JID. Returns null
  // when the store has no mapping yet (HTTP 404).
  async getStoredLid(sessionId: string, jid: string): Promise<string | null> {
    try {
      const res = await this.request<{ lid?: string | null }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(jid)}/lid`, {}, 1);
      return res?.lid ? String(res.lid) : null;
    } catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
  // Resolves true on the callee's Accept. `onRinging` fires on its PreAccept: the
  // callee's phone got the offer and is ringing (WhatsApp's "Chamando…").
  async waitForOutgoingAnswer(sessionId: string, callId: string, signal: AbortSignal, onRinging?: () => void) {
    const connection = await this.getNatsConnection();
    const subscription = connection.subscribe(`wa.events.${sessionId}.incoming_call`);
    const codec = StringCodec();
    const stop = () => subscription.unsubscribe();
    signal.addEventListener('abort', stop, { once: true });
    try {
      for await (const message of subscription) {
        try {
          const payload = JSON.parse(codec.decode(message.data)) as { event?: string; data?: { call_id?: string; action?: string } };
          const action = String(payload.data?.action ?? '');
          if (payload.event !== 'incoming_call' || payload.data?.call_id !== callId) continue;
          if (/^\s*PreAccept\b/.test(action)) { onRinging?.(); continue; }
          if (/\bAccept\b/.test(action)) return true;
        } catch {
          // Ignore unrelated or malformed events on the session subject.
        }
      }
      return false;
    } finally {
      signal.removeEventListener('abort', stop);
      subscription.unsubscribe();
    }
  }

  // `codec` picks the audio codec of this one call (Waxum zapliga-signal patch); absent follows
  // the Waxum's WA_CALL_AUDIO_CODEC. An older Waxum ignores it.
  async openMedia(sessionId: string, recipient: string, codec?: 'opus' | 'mlow') {
    const httpUrl = `${await this.sessionUrl(sessionId)}/api/v1/sessions/${encodeURIComponent(sessionId)}/calls/media/ws?to=${encodeURIComponent(recipient)}&kind=audio${codec ? `&codec=${codec}` : ''}`;
    return new WebSocket(httpUrl.replace(/^http/, 'ws'), { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined });
  }

  // Explicitly hang up an outgoing call. Closing the media WS alone can leave
  // the callee's WhatsApp showing "Reconnecting…" instead of ending the call
  // (the media transport drops without a `<terminate>` signalling stanza).
  // While the call is still active in Waxum, `terminate` looks it up by
  // `call_id` and calls `handle.hangup()` directly (the `peer` is ignored on
  // that path), so this reliably sends the terminate stanza to the lead.
  terminateCall(sessionId: string, peer: string, callId: string, reason = 'hangup') {
    return this.request<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/calls/terminate`,
      { method: 'POST', body: JSON.stringify({ peer, call_id: callId, reason }) },
      1,
    );
  }
}
