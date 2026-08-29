const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
let accessToken = '';
let activeTenantId = '';
let refreshInFlight: Promise<boolean> | null = null;
let accessTokenRevision = 0;
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
export const setActiveTenantId = (tenantId: string) => { activeTenantId = tenantId; };
export const clearActiveTenantId = () => { activeTenantId = ''; };

refreshChannel?.addEventListener('message', (event) => {
  if (event.data?.type === 'access-token-updated' && typeof event.data.token === 'string') {
    setAccessToken(event.data.token, false);
  }
});

const tenantRoute = (path: string) => {
  if (!activeTenantId || path.startsWith('/api/tenants/')) return path;
  const resources = ['/api/leads', '/api/lead-folders', '/api/numbers', '/api/sdrs', '/api/calls', '/api/dialer', '/api/me/sdr'];
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
  return fetch(`${API}${resolvedPath}`, { ...init, headers, credentials: 'include' });
};

export const apiFetch = fetchJson;

const rotateRefreshToken = async () => {
  const response = await fetch(`${API}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.accessToken) { clearAccessToken(); return false; }
  setAccessToken(body.accessToken);
  return true;
};

export const refreshAccessToken = () => {
  // Several API calls can receive 401 at the same time (for example when a
  // dashboard refreshes all of its widgets). Since refresh tokens rotate,
  // those calls must share one rotation instead of racing with each other.
  if (refreshInFlight) return refreshInFlight;
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

export const json = async (path: string, init?: RequestInit, retry = true): Promise<any> => {
  const tokenAtRequest = accessToken;
  const response = await fetchJson(path, init);
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    // Another request/tab may already have completed the rotation while this
    // request was in flight. Reuse that token before attempting another one.
    if (tokenAtRequest !== accessToken && accessToken) return json(path, init, false);
    if (await refreshAccessToken()) return json(path, init, false);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Erro na API');
  return body;
};
