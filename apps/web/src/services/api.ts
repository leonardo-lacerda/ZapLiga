const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
let accessToken = '';
let activeTenantId = '';

export const apiBaseUrl = API;
export const wsUrl = () => { const api = new URL(API); return `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`; };

export const setAccessToken = (token: string) => { accessToken = token; };
export const clearAccessToken = () => { accessToken = ''; };
export const setActiveTenantId = (tenantId: string) => { activeTenantId = tenantId; };
export const clearActiveTenantId = () => { activeTenantId = ''; };

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

export const refreshAccessToken = async () => {
  const response = await fetch(`${API}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.accessToken) { clearAccessToken(); return false; }
  setAccessToken(body.accessToken);
  return true;
};

export const json = async (path: string, init?: RequestInit, retry = true): Promise<any> => {
  const response = await fetchJson(path, init);
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    if (await refreshAccessToken()) return json(path, init, false);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Erro na API');
  return body;
};
