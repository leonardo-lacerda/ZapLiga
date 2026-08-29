import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';
import WebSocket from 'ws';

type WaxumSession = { id: string; name?: string; phone_number?: string; status?: string };

@Injectable()
export class WaxumClient implements OnModuleDestroy {
  private readonly baseUrl = (process.env.WAXUM_URL ?? 'http://localhost:3451').replace(/\/$/, '');
  private readonly apiKey = process.env.WAXUM_API_KEY;
  private readonly natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
  private readonly requestIntervalMs = (() => {
    const configured = Number(process.env.WAXUM_REQUEST_INTERVAL_MS ?? 250);
    return Number.isFinite(configured) ? Math.max(0, configured) : 250;
  })();
  private requestChain: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private natsConnection?: Promise<NatsConnection>;

  async onModuleDestroy() {
    const connection = await this.natsConnection?.catch(() => undefined);
    await connection?.drain();
  }

  private getNatsConnection() {
    this.natsConnection ??= connect({ servers: this.natsUrl, name: 'zapliga-api' });
    return this.natsConnection;
  }

  private headers() { return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }; }

  private request<T>(path: string, init: RequestInit = {}, maxAttempts = 3): Promise<T> {
    const run = () => this.requestWithRetry<T>(path, init, maxAttempts);
    const queued = this.requestChain.then(run, run);
    this.requestChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async waitForRequestSlot() {
    const now = Date.now();
    const waitMs = Math.max(0, this.nextRequestAt - now);
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.requestIntervalMs;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async requestWithRetry<T>(path: string, init: RequestInit, maxAttempts: number): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.waitForRequestSlot();
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10000), headers: { ...this.headers(), ...(init.headers ?? {}) } });
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

  async createSession(name: string) { return (await this.request<{ session: WaxumSession }>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ name }) })).session; }
  deleteSession(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, 1); }
  getQr(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/qr`); }
  getStatus(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, {}, 1); }
  reconnect(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/connect`, { method: 'POST', body: JSON.stringify({}) }).catch((error: Error & { statusCode?: number }) => { if (error.statusCode === 409) return { already_connecting: true }; throw error; }); }
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
  async waitForOutgoingAnswer(sessionId: string, callId: string, signal: AbortSignal) {
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
          if (payload.event === 'incoming_call' && payload.data?.call_id === callId && /\bAccept\b/.test(action)) return true;
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

  openMedia(sessionId: string, recipient: string) {
    const httpUrl = `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/calls/media/ws?to=${encodeURIComponent(recipient)}&kind=audio`;
    return new WebSocket(httpUrl.replace(/^http/, 'ws'), { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined });
  }
}
