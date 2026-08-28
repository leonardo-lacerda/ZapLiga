import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearAccessToken, clearActiveTenantId, json, refreshAccessToken, setAccessToken, setActiveTenantId } from '../../services/api';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  platformRole: 'user' | 'super_admin';
  status: string;
};

export type AuthSession = {
  user: AuthUser;
  tenants: Array<{ id: string; name: string; slug: string; status: string; role?: string; membership_status?: string }>;
};

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; companyName: string; companySlug?: string }) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  activeTenantId: string;
  setTenant: (tenantId: string) => void;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [activeTenantId, setActiveTenantState] = useState('');
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((next: AuthSession) => {
    setSession(next);
    const available = next.tenants.find((tenant) => tenant.status === 'active');
    if (available) { setActiveTenantId(available.id); setActiveTenantState(available.id); }
    else { clearActiveTenantId(); setActiveTenantState(''); }
  }, []);

  const reload = useCallback(async () => {
    try {
      if (!await refreshAccessToken()) { setSession(null); return; }
      applySession(await json('/api/auth/me', undefined, false));
    } catch {
      clearAccessToken();
      setSession(null);
    }
  }, [applySession]);

  useEffect(() => { void reload().finally(() => setLoading(false)); }, [reload]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setAccessToken(result.accessToken);
    applySession(await json('/api/auth/me', undefined, false));
  }, [applySession]);

  const register = useCallback(async (input: { name: string; email: string; password: string; companyName: string; companySlug?: string }) => {
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

  const setTenant = useCallback((tenantId: string) => { setActiveTenantId(tenantId); setActiveTenantState(tenantId); }, []);

  const value = useMemo(() => ({ session, loading, login, register, acceptInvite, logout, activeTenantId, setTenant, reload }), [session, loading, login, register, acceptInvite, logout, activeTenantId, setTenant, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return value;
}
