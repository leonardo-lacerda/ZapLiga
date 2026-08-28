import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, StringCodec } from 'nats';
import WebSocket from 'ws';

type WaxumSession = { id: string; name?: string; phone_number?: string; status?: string };
type WaxumContactInfo = { jid?: string; lid?: string | null; is_registered?: boolean };

@Injectable()
export class WaxumClient implements OnModuleDestroy {
  private readonly baseUrl = (process.env.WAXUM_URL ?? 'http://localhost:3451').replace(/\/$/, '');
  private readonly apiKey = process.env.WAXUM_API_KEY;
  private readonly natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222';
  private requestChain: Promise<void> = Promise.resolve();
  private natsConnection?: Promise<NatsConnection>;

  async onModuleDestroy() {
    const connection = await this.natsConnection?.catch(() => undefined);
    await connection?.drain();
  }

  private getNatsConnection() {
    this.natsConnection ??= connect({ servers: this.natsUrl, name: 'zapcall-api' });
    return this.natsConnection;
  }

  private headers() { return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }; }

  private request<T>(path: string, init: RequestInit = {}, maxAttempts = 3): Promise<T> {
    const run = () => this.requestWithRetry<T>(path, init, maxAttempts);
    const queued = this.requestChain.then(run, run);
    this.requestChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async requestWithRetry<T>(path: string, init: RequestInit, maxAttempts: number): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10000), headers: { ...this.headers(), ...(init.headers ?? {}) } });
      const body = await response.text();
      let parsed: any = body;
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* plain response */ }
      if (response.ok) return parsed as T;
      if (response.status === 429 && attempt < maxAttempts - 1) {
        const match = typeof parsed === 'string' ? parsed.match(/wait for\s+(\d+)s/i) : null;
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, Number(match?.[1] ?? 5) + 1) * 1000));
        continue;
      }
      const error = new Error(`Waxum ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`) as Error & { statusCode?: number };
      error.statusCode = response.status;
      throw error;
    }
    throw new Error('Waxum request failed');
  }

  async createSession(name: string) { return (await this.request<{ session: WaxumSession }>('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ name }) })).session; }
  deleteSession(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, 1); }
  getQr(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/qr`); }
  getStatus(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/status`, {}, 1); }
  reconnect(sessionId: string) { return this.request<any>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/connect`, { method: 'POST', body: JSON.stringify({}) }).catch((error: Error & { statusCode?: number }) => { if (error.statusCode === 409) return { already_connecting: true }; throw error; }); }
  async resolveCallRecipient(sessionId: string, phone: string) {
    // VoIP media needs the recipient's LID, not only the phone-number JID.
    // The /contacts/check endpoint only reports registration; /contacts/info
    // also returns the PN -> LID mapping that Waxum uses for media keys.
    const normalized = phone.includes('@') ? phone : phone.replace(/\D/g, '');
    if (normalized.endsWith('@lid')) return normalized;

    const response = await this.request<{ contacts?: WaxumContactInfo[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/contacts/info`,
      { method: 'POST', body: JSON.stringify({ phones: [normalized] }) },
      1,
    );
    const contact = response.contacts?.find((item) => item.is_registered !== false);
    if (!contact) throw new Error(`Waxum nao encontrou o contato ${normalized}`);
    if (!contact.lid) throw new Error(`Waxum nao retornou o LID do contato ${normalized}`);
    return contact.lid;
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
