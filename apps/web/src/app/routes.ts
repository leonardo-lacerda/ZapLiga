import type { TabKey } from '../types';

export const tabPaths: Record<TabKey, string> = {
  dashboard: '/app/',
  sdrMetrics: '/app/meus-resultados',
  metrics: '/app/metricas',
  numbers: '/app/numeros',
  leads: '/app/leads',
  sdrs: '/app/sdrs',
  calls: '/app/historico',
  access: '/app/acesso',
  admin: '/app/admin',
};

const tabPathEntries = Object.entries(tabPaths) as Array<[TabKey, string]>;

export function tabFromPath(pathname: string): TabKey {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return tabPathEntries.find(([, path]) => (path.replace(/\/+$/, '') || '/') === normalized)?.[0] ?? 'dashboard';
}

export function authRouteFromPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const inviteMatch = normalized.match(/^\/(?:app\/)?(?:convite|invite)\/([^/]+)$/);
  if (inviteMatch) return { type: 'invite' as const, token: decodeURIComponent(inviteMatch[1]) };
  if (['/registro', '/cadastro', '/app/registro', '/app/cadastro'].includes(normalized)) return { type: 'register' as const };
  return { type: 'login' as const };
}

export function isPublicAuthPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized === '/login'
    || normalized === '/registro'
    || normalized === '/cadastro'
    || normalized === '/app'
    || normalized === '/app/login'
    || normalized === '/app/registro'
    || normalized === '/app/cadastro'
    || /^\/(?:app\/)?(?:convite|invite)\/[^/]+$/.test(normalized);
}

export function navigateToTab(tab: TabKey) {
  const path = tabPaths[tab];
  if (window.location.pathname !== path) window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
