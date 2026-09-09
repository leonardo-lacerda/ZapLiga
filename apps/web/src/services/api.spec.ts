import { vi } from 'vitest';
import { ApiError, apiFetch, clearAccessToken, clearActiveTenantId, json, readJsonBody, runAuthTransition, setAccessToken, setActiveTenantId } from './api';

describe('tenant request lifecycle', () => {
  afterEach(() => { clearAccessToken(); clearActiveTenantId(); vi.unstubAllGlobals(); });

  it('extracts nested Nest conflict payloads into ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      statusCode: 409,
      message: { code: 'feature_disabled', feature: 'callbacks', message: 'Recurso temporariamente indisponivel para esta empresa' },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    setAccessToken(`x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }))}.y`);
    await expect(json('/api/callbacks')).rejects.toMatchObject({
      name: 'ApiError',
      message: 'Recurso temporariamente indisponivel para esta empresa',
      code: 'feature_disabled',
      feature: 'callbacks',
      status: 409,
    });
    expect(ApiError).toBeDefined();
  });

  it('rewrites new feature aliases and aborts the old tenant request on switch', async () => {
    let capturedUrl = ''; let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { capturedUrl = url; capturedSignal = init?.signal ?? undefined; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }));
    setActiveTenantId('tenant-a');
    await apiFetch('/api/callbacks');
    expect(capturedUrl).toContain('/api/tenants/tenant-a/callbacks');
    expect(capturedSignal?.aborted).toBe(false);
    setActiveTenantId('tenant-b');
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('refreshes an expired access token before sending a protected request', async () => {
    const futurePayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: `x.${futurePayload}.y` }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    setAccessToken('x.eyJleHAiOjF9.y');

    await expect(json('/api/numbers')).resolves.toEqual({ ok: true });
    expect(urls).toEqual([
      'http://localhost:3000/api/auth/refresh',
      'http://localhost:3000/api/numbers',
    ]);
  });

  it('does not let a stale 401 rotate the refresh cookie during an account switch', async () => {
    const oldPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const nextPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const oldToken = `old.${oldPayload}.token`;
    const nextToken = `next.${nextPayload}.token`;
    const urls: string[] = [];
    let numbersRequests = 0;
    let releaseTransition!: () => void;
    const transitionPaused = new Promise<void>((resolve) => { releaseTransition = resolve; });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/numbers')) {
        numbersRequests += 1;
        return new Response('{}', { status: numbersRequests === 1 ? 401 : 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).endsWith('/api/auth/refresh')) return new Response(JSON.stringify({ accessToken: nextToken }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    setAccessToken(oldToken);

    const transition = runAuthTransition(async () => {
      await transitionPaused;
      setAccessToken(nextToken);
    });
    const request = json('/api/numbers');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toEqual(['http://localhost:3000/api/numbers']);
    releaseTransition();
    await transition;
    await expect(request).resolves.toEqual({});
    expect(urls).toEqual([
      'http://localhost:3000/api/numbers',
      'http://localhost:3000/api/numbers',
    ]);
  });

  it('refreshes normally after a completed auth transition instead of recursing forever', async () => {
    const futurePayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: `next.${futurePayload}.token` }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    await runAuthTransition(async () => { setAccessToken('expired.eyJleHAiOjF9.token'); });
    await expect(json('/api/numbers')).resolves.toEqual({ ok: true });
    expect(urls).toEqual([
      'http://localhost:3000/api/auth/refresh',
      'http://localhost:3000/api/numbers',
    ]);
  });

  it('cancels a streamed JSON response before it can exhaust browser memory', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"'));
        controller.enqueue(new Uint8Array(32));
        controller.close();
      },
    });

    await expect(readJsonBody(new Response(stream), 16)).rejects.toThrow('excedeu o limite seguro');
  });

  it('rejects a declared oversized response without reading its body', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-length': '1000' } });
    await expect(readJsonBody(response, 100)).rejects.toThrow('excedeu o limite seguro');
    expect(response.bodyUsed).toBe(true);
  });
});
