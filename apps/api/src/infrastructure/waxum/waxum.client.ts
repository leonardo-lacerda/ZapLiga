import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';

type WaxumSession = { id: string; name?: string; phone_number?: string; status?: string };

@Injectable()
export class WaxumClient {
  private readonly baseUrl = (process.env.WAXUM_URL ?? 'http://localhost:3451').replace(/\/$/, '');
  private readonly apiKey = process.env.WAXUM_API_KEY;
  private requestChain: Promise<void> = Promise.resolve();

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
  async waitForOutgoingAnswer(sessionId: string, callId: string, signal: AbortSignal) {
    const url = `${this.baseUrl}/api/v1/events/tail?session=${encodeURIComponent(sessionId)}&event=incoming_call`;
    const response = await fetch(url, { headers: this.headers(), signal });
    if (!response.ok) throw new Error(`Waxum events ${response.status}`);
    if (!response.body) throw new Error('Waxum events stream has no body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let eventName = '';
    let dataLines: string[] = [];
    const consumeEvent = () => {
      const data = dataLines.join('\n');
      const currentName = eventName;
      eventName = '';
      dataLines = [];
      if (currentName !== 'incoming_call' || !data) return false;
      try {
        const consoleEvent = JSON.parse(data) as { payload_preview?: string };
        const payload = JSON.parse(consoleEvent.payload_preview ?? '{}') as { event?: string; data?: { call_id?: string; action?: string } };
        const action = String(payload.data?.action ?? '');
        if (payload.event !== 'incoming_call' || payload.data?.call_id !== callId) return false;
        // The current Waxum event tail exposes only a bounded payload preview.
        // When the action is present, require Accept; if it was truncated, the
        // media frame after this matching signaling event is the second gate.
        return !action || /\bAccept\s*\{/.test(action);
      } catch {
        return false;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (done) return false;
      while (true) {
        const boundary = pending.indexOf('\n\n');
        if (boundary < 0) break;
        const rawEvent = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (consumeEvent()) {
          await reader.cancel();
          return true;
        }
      }
    }
  }

  openMedia(sessionId: string, phone: string) {
    const httpUrl = `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/calls/media/ws?to=${encodeURIComponent(phone)}&kind=audio`;
    return new WebSocket(httpUrl.replace(/^http/, 'ws'), { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined });
  }
}
