import { vi } from 'vitest';
import { apiFetch, clearActiveTenantId, setActiveTenantId } from './api';

describe('tenant request lifecycle', () => {
  afterEach(() => { clearActiveTenantId(); vi.unstubAllGlobals(); });

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
});
