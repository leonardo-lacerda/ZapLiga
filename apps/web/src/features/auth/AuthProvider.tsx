import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { clearAccessToken, clearActiveTenantId, json, refreshAccessToken, refreshFailureReason, runAuthTransition, setAccessToken, setActiveTenantId, shouldRefreshAccessToken, waitForRefresh } from '../../services/api';

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

export type SavedAccount = {
  id: string;
  name: string;
  email: string;
  platformRole: 'user' | 'super_admin';
  lastUsedAt?: string | null;
  current: boolean;
};

type AuthContextValue = {
  session: AuthSession | null;
  savedAccounts: SavedAccount[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string; companyName: string; companySlug?: string; legalAccepted: boolean }) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  activeTenantId: string;
  selectTenant: (tenantId: string) => void;
  switchAccount: (accountId: string) => Promise<void>;
  addAccount: (email: string, password: string) => Promise<void>;
  removeSavedAccount: (accountId: string) => Promise<void>;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
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

  const loadSavedAccounts = useCallback(async (user: AuthUser | null) => {
    if (!user) { setSavedAccounts([]); return; }
    try {
      setSavedAccounts(await json('/api/auth/accounts', undefined, false));
    } catch {
      // Account switching is an enhancement and must never make a valid
      // primary session look like a failed login during a partial deploy.
      setSavedAccounts((current) => {
        const normalized = current.map((account) => ({ ...account, current: account.id === user.id }));
        if (normalized.some((account) => account.id === user.id)) return normalized;
        return [{ id: user.id, name: user.name, email: user.email, platformRole: user.platformRole, current: true }, ...normalized];
      });
    }
  }, []);

  const reload = useCallback(async () => {
    return runAuthTransition(async () => {
      try {
        if (!await refreshAccessToken(true)) {
          // Keep an already authenticated session during a transient network or
          // server failure. The next interval/401 will retry the refresh.
          if (refreshFailureReason() === 'transient' && sessionRef.current) return;
          setSession(null); setSavedAccounts([]);
          return;
        }
        const next = await json('/api/auth/me', undefined, false);
        applySession(next);
        await loadSavedAccounts(next.user);
      } catch {
        clearAccessToken();
        setSession(null); setSavedAccounts([]);
      }
    });
  }, [applySession, loadSavedAccounts]);

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
    // A dashboard poll fires several requests at once; when the API answers
    // 401 to all of them, each one dispatches this event. One reload settles
    // the session for all of them, so coalesce the burst instead of queueing
    // one reload (and one refresh-token rotation) per rejected request.
    let pending = false;
    const accessChanged = () => {
      if (pending) return;
      pending = true;
      void reload().finally(() => { pending = false; });
    };
    window.addEventListener('zapliga:access-changed', accessChanged);
    return () => window.removeEventListener('zapliga:access-changed', accessChanged);
  }, [reload]);

  const login = useCallback(async (email: string, password: string) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      const result = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setAccessToken(result.accessToken);
      const next = await json('/api/auth/me', undefined, false); applySession(next); await loadSavedAccounts(next.user);
    });
  }, [applySession, loadSavedAccounts]);

  const register = useCallback(async (input: { name: string; email: string; password: string; companyName: string; companySlug?: string; legalAccepted: boolean }) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      const result = await json('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
      setAccessToken(result.accessToken);
      const next = await json('/api/auth/me', undefined, false); applySession(next); await loadSavedAccounts(next.user);
    });
  }, [applySession, loadSavedAccounts]);

  const acceptInvite = useCallback(async (token: string, name: string, password: string) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      const result = await json(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify({ name, password }) });
      setAccessToken(result.accessToken);
      const next = await json('/api/auth/me', undefined, false); applySession(next); await loadSavedAccounts(next.user);
    });
  }, [applySession, loadSavedAccounts]);

  const switchAccount = useCallback(async (accountId: string) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      if (shouldRefreshAccessToken(5) && !await refreshAccessToken(true)) throw new Error('Sua sessão expirou. Entre novamente para continuar.');
      const result = await json(`/api/auth/accounts/${encodeURIComponent(accountId)}/switch`, { method: 'POST' });
      if (!result?.accessToken) {
        if (result?.switched === false) return;
        throw new Error('Não foi possível trocar de conta. Tente novamente.');
      }
      setAccessToken(result.accessToken);
      // Abort in-flight tenant fetches immediately, but wait until after /me to
      // reset React tenant state. Clearing before the await published
      // activeTenantId='' with the old session still mounted, flipping isSdr and
      // crashing AuthenticatedApp via antagonistic tab effects.
      clearActiveTenantId();
      window.localStorage.removeItem('zapliga_active_tenant');
      const nextSession = await json('/api/auth/me', undefined, false);
      // Same synchronous turn as applySession so React 18 batches the empty
      // reset with the new tenant and never paints the broken intermediate UI.
      setActiveTenantState('');
      applySession(nextSession);
      await loadSavedAccounts(nextSession.user);
    });
  }, [applySession, loadSavedAccounts]);

  const addAccount = useCallback(async (email: string, password: string) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      if (shouldRefreshAccessToken(5) && !await refreshAccessToken(true)) throw new Error('Sua sessão expirou. Entre novamente para continuar.');
      const result = await json('/api/auth/accounts/add', { method: 'POST', body: JSON.stringify({ email, password }) });
      if (!result?.accessToken) throw new Error('Não foi possível adicionar a conta. Tente novamente.');
      setAccessToken(result.accessToken);
      clearActiveTenantId();
      window.localStorage.removeItem('zapliga_active_tenant');
      const next = await json('/api/auth/me', undefined, false);
      setActiveTenantState('');
      applySession(next);
      await loadSavedAccounts(next.user);
    });
  }, [applySession, loadSavedAccounts]);

  const removeSavedAccount = useCallback(async (accountId: string) => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      if (shouldRefreshAccessToken(5) && !await refreshAccessToken(true)) throw new Error('Sua sessão expirou. Entre novamente para continuar.');
      await json(`/api/auth/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
      setSavedAccounts((current) => current.filter((account) => account.id !== accountId));
    });
  }, []);

  const logout = useCallback(async () => {
    return runAuthTransition(async () => {
      await waitForRefresh();
      try { await json('/api/auth/logout', { method: 'POST' }, false); } finally { clearAccessToken(); clearActiveTenantId(); setActiveTenantState(''); setSession(null); setSavedAccounts([]); }
    });
  }, []);

  const value = useMemo(() => ({ session, savedAccounts, loading, login, register, acceptInvite, logout, activeTenantId, selectTenant, switchAccount, addAccount, removeSavedAccount, reload }), [session, savedAccounts, loading, login, register, acceptInvite, logout, activeTenantId, selectTenant, switchAccount, addAccount, removeSavedAccount, reload]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return value;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
