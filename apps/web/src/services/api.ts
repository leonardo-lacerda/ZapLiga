const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
let accessToken = '';
let activeTenantId = '';
let tenantRequestController = new AbortController();
let refreshInFlight: Promise<boolean> | null = null;
let authTransitionInFlight: Promise<unknown> | null = null;
let accessTokenRevision = 0;
let lastRefreshFailure: 'unauthorized' | 'transient' | null = null;
const refreshChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('zapliga-auth') : null;

export const apiBaseUrl = API;
export const wsUrl = () => { const api = new URL(API); return `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`; };

export const setAccessToken = (token: string, broadcast = true) => {
  accessToken = token;
  accessTokenRevision += 1;
  if (broadcast) refreshChannel?.postMessage({ type: 'access-token-updated', token });
};
export const clearAccessToken = () => { accessToken = ''; };
const accessTokenExpiresAt = (token: string) => {
  try {
    const encodedPayload = token.split('.')[1];
    if (!encodedPayload) return 0;
    const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) * 1000;
  } catch {
    return 0;
  }
};
export const shouldRefreshAccessToken = (leewaySeconds = 120) => {
  if (!accessToken) return false;
  const expiresAt = accessTokenExpiresAt(accessToken);
  return !expiresAt || expiresAt <= Date.now() + leewaySeconds * 1000;
};
export const setActiveTenantId = (tenantId: string) => { if (tenantId !== activeTenantId) { tenantRequestController.abort(); tenantRequestController = new AbortController(); } activeTenantId = tenantId; };
export const clearActiveTenantId = () => { tenantRequestController.abort(); tenantRequestController = new AbortController(); activeTenantId = ''; };

refreshChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'access-token-updated' && typeof event.data.token === 'string') {
    setAccessToken(event.data.token, false);
  }
});

const tenantRoute = (path: string) => {
  if (!activeTenantId || path.startsWith('/api/tenants/')) return path;
  const resources = ['/api/leads', '/api/lead-folders', '/api/numbers', '/api/sdrs', '/api/calls', '/api/dialer', '/api/callbacks', '/api/privacy', '/api/onboarding', '/api/me/sdr'];
  const resource = resources.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
  if (!resource) return path;
  const suffix = path.slice(resource.length);
  const name = resource === '/api/me/sdr' ? 'me/sdr' : resource.slice('/api/'.length);
  return `/api/tenants/${encodeURIComponent(activeTenantId)}/${name}${suffix}`;
};

const fetchJson = async (path: string, init?: RequestInit) => {
  const resolvedPath = tenantRoute(path);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type') && !(init?.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  if (activeTenantId && !headers.has('x-tenant-id')) headers.set('x-tenant-id', activeTenantId);
  const isTenantRequest = Boolean(activeTenantId) && resolvedPath.startsWith('/api/tenants/');
  return fetch(`${API}${resolvedPath}`, { ...init, headers, credentials: 'include', signal: init?.signal ?? (isTenantRequest ? tenantRequestController.signal : undefined) });
};

export const apiFetch = fetchJson;

export const runAuthTransition = <T,>(operation: () => Promise<T>) => {
  const previous = authTransitionInFlight ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  authTransitionInFlight = current.then(() => undefined, () => undefined);
  return current;
};

export const waitForRefresh = async () => {
  const pending = refreshInFlight;
  if (pending) await pending.catch(() => false);
};

const rotateRefreshToken = async () => {
  // A transient 5xx/network failure must not turn an otherwise valid session
  // into a logout. A rotated token may also briefly race with another tab, so
  // retry a few times before declaring the refresh unavailable.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API}/api/auth/refresh`, { method: 'POST', credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.accessToken) {
        lastRefreshFailure = null;
        setAccessToken(body.accessToken);
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        lastRefreshFailure = 'unauthorized';
        clearAccessToken();
        return false;
      }
    } catch {
      // Retry below; the refresh cookie remains intact.
    }
    lastRefreshFailure = 'transient';
    if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
  }
  return false;
};

export const refreshFailureReason = () => lastRefreshFailure;

export const refreshAccessToken = (allowDuringAuthTransition = false): Promise<boolean> => {
  // Several API calls can receive 401 at the same time (for example when a
  // dashboard refreshes all of its widgets). Since refresh tokens rotate,
  // those calls must share one rotation instead of racing with each other.
  if (refreshInFlight) return refreshInFlight;
  if (authTransitionInFlight && !allowDuringAuthTransition) {
    const tokenBeforeTransition = accessToken;
    return authTransitionInFlight.then(() => {
      // The transition already installed a newer account token. Reuse it
      // instead of rotating the new account's refresh cookie unnecessarily.
      if (accessToken && accessToken !== tokenBeforeTransition) return true;
      return refreshAccessToken();
    });
  }
  const revisionAtStart = accessTokenRevision;
  refreshInFlight = (async () => {
    // The refresh cookie is shared by tabs. The Web Locks API serializes
    // rotations across them, while BroadcastChannel shares the new in-memory
    // access token without persisting credentials in localStorage.
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const rotate = async () => {
      if (accessToken && accessTokenRevision !== revisionAtStart) return true;
      return rotateRefreshToken();
    };
    if (locks) return locks.request('zapliga-auth-refresh', rotate);
    return rotate();
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly feature?: string;
  readonly details: unknown;

  constructor(status: number, body: any) {
    const payload = body?.message;
    const message = typeof payload === 'string'
      ? payload
      : typeof payload?.message === 'string'
        ? payload.message
        : typeof body?.error === 'string'
          ? body.error
          : 'Erro na API';
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof payload?.code === 'string' ? payload.code : typeof body?.code === 'string' ? body.code : undefined;
    this.feature = typeof payload?.feature === 'string' ? payload.feature : undefined;
    this.details = body;
  }
}

export const json = async (path: string, init?: RequestInit, retry = true): Promise<any> => {
  // Do not knowingly send an expired access token. This is especially
  // important when a suspended/mobile tab becomes visible again: its polling
  // effects can start several requests before AuthProvider's visibility
  // handler finishes rotating the token, producing a burst of avoidable 401s.
  if (retry && !path.startsWith('/api/auth/') && shouldRefreshAccessToken(5)) {
    await refreshAccessToken();
  }
  const tokenAtRequest = accessToken;
  const response = await fetchJson(path, init);
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    // Another request/tab may already have completed the rotation while this
    // request was in flight. Reuse that token before attempting another one.
    if (tokenAtRequest !== accessToken && accessToken) return json(path, init, false);
    if (await refreshAccessToken()) return json(path, init, false);
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('zapliga:access-changed'));
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
};
