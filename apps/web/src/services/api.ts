const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export const apiBaseUrl = API;
export const wsUrl = () => { const api = new URL(API); return `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`; };

export const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${API}${path}`, { headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Erro na API');
  return body;
};

