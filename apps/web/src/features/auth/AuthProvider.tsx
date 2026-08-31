import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { clearAccessToken, clearActiveTenantId, json, refreshAccessToken, refreshFailureReason, setAccessToken, setActiveTenantId, shouldRefreshAccessToken } from '../../services/api';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  platformRole: 'user' | 'super_admin';
  status: string;
  emailVerifiedAt?: string | null;
  passwordChangedAt?: string | null;
  forcePasswordChange?: boolean;
};

export type AuthSession = {
  user: AuthUser;
  tenants: Array<{ id: string; name: string; slug: string; status: string; role?: string; membership_status?: string }>;
  legalAcceptanceRequired?: boolean;
  pendingLegalDocuments?: Array<{ id: string; document_type: string; version: string; title: string; url: string }>;
};

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; companyName: string; companySlug?: string; legalAccepted: boolean }) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  activeTenantId: string;
  selectTenant: (tenantId: string) => void;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [activeTenantId, setActiveTenantState] = useState('');
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef<AuthSession | null>(null);

  useEffect(() => { sessionRef.current = session; }, [session]);

  const selectTenant = useCallback((tenantId: string) => {
    if (!session?.tenants.some((tenant) => tenant.id === tenantId && tenant.status === 'active')) return;
    setActiveTenantId(tenantId);
    window.localStorage.setItem('zapliga_active_tenant', tenantId);
    setActiveTenantState(tenantId);
  }, [session]);

  const applySession = useCallback((next: AuthSession) => {
    setSession(next);
    setActiveTenantState((current) => {
      const preferredId = current || window.localStorage.getItem('zapliga_active_tenant') || '';
      const available = next.tenants.find((tenant) => tenant.id === preferredId && tenant.status === 'active' && tenant.membership_status !== 'blocked')
        ?? next.tenants.find((tenant) => tenant.status === 'active');
      if (available) { setActiveTenantId(available.id); window.localStorage.setItem('zapliga_active_tenant', available.id); return available.id; }
      clearActiveTenantId();
      return '';
    });
  }, []);

  const reload = useCallback(async () => {
    try {
      if (!await refreshAccessToken()) {
        // Keep an already authenticated session during a transient network or
        // server failure. The next interval/401 will retry the refresh.
        if (refreshFailureReason() === 'transient' && sessionRef.current) return;
        setSession(null);
        return;
      }
      applySession(await json('/api/auth/me', undefined, false));
    } catch {
      clearAccessToken();
      setSession(null);
    }
  }, [applySession]);

  useEffect(() => { void reload().finally(() => setLoading(false)); }, [reload]);

  useEffect(() => {
    if (!session) return undefined;
    let lastAttemptAt = 0;
    const refreshOnResume = () => {
      if (document.visibilityState !== 'visible' || !shouldRefreshAccessToken()) return;
      const now = Date.now();
      if (now - lastAttemptAt < 5000) return;
      lastAttemptAt = now;
      void reload();
    };
    document.addEventListener('visibilitychange', refreshOnResume);
    window.addEventListener('pageshow', refreshOnResume);
    return () => {
      document.removeEventListener('visibilitychange', refreshOnResume);
      window.removeEventListener('pageshow', refreshOnResume);
    };
  }, [reload, session]);

  // Access tokens are intentionally short-lived. Refresh while the tab is
  // open so a user does not get logged out simply because the dashboard was
  // left open without a visibility change or API request.
  useEffect(() => {
    if (!session) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && shouldRefreshAccessToken(180)) void reload();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [reload, session]);

  useEffect(() => {
    const accessChanged = () => void reload();
    window.addEventListener('zapliga:access-changed', accessChanged);
    return () => window.removeEventListener('zapliga:access-changed', accessChanged);
  }, [reload]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setAccessToken(result.accessToken);
    applySession(await json('/api/auth/me', undefined, false));
  }, [applySession]);

  const register = useCallback(async (input: { name: string; email: string; password: string; companyName: string; companySlug?: string; legalAccepted: boolean }) => {
    const result = await json('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
    setAccessToken(result.accessToken);
    applySession(await json('/api/auth/me', undefined, false));
  }, [applySession]);

  const acceptInvite = useCallback(async (token: string, name: string, password: string) => {
    const result = await json(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify({ name, password }) });
    setAccessToken(result.accessToken);
    applySession(await json('/api/auth/me', undefined, false));
  }, [applySession]);

  const logout = useCallback(async () => {
    try { await json('/api/auth/logout', { method: 'POST' }, false); } finally { clearAccessToken(); clearActiveTenantId(); setActiveTenantState(''); setSession(null); }
  }, []);

  const value = useMemo(() => ({ session, loading, login, register, acceptInvite, logout, activeTenantId, selectTenant, reload }), [session, loading, login, register, acceptInvite, logout, activeTenantId, selectTenant, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return value;
}
