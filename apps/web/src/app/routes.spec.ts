import { authRouteFromPath, isPublicAuthPath, tabFromPath, tabPaths } from './routes';

describe('navigation routes', () => {
  it('maps every protected feature to a stable URL', () => {
    for (const [tab, path] of Object.entries(tabPaths)) expect(tabFromPath(path)).toBe(tab);
  });
  it('recognizes account recovery links and their token', () => {
    window.history.replaceState({}, '', '/redefinir-senha?token=token-123');
    expect(authRouteFromPath(window.location.pathname)).toEqual({ type: 'reset', token: 'token-123' });
  });
  it('keeps the friendly sign-in URL public', () => {
    expect(isPublicAuthPath('/entrar')).toBe(true);
    expect(authRouteFromPath('/entrar')).toEqual({ type: 'login' });
  });
});
