import { authRouteFromPath, navigateToTab, tabFromPath, tabPaths } from './routes';

describe('navigation routes', () => {
  it('maps every protected feature to a stable URL', () => {
    for (const [tab, path] of Object.entries(tabPaths)) expect(tabFromPath(path)).toBe(tab);
  });
  it('recognizes account recovery links and their token', () => {
    window.history.replaceState({}, '', '/redefinir-senha?token=token-123');
    expect(authRouteFromPath(window.location.pathname)).toEqual({ type: 'reset', token: 'token-123' });
  });
  it('does not re-dispatch popstate when navigateToTab targets the current path', () => {
    window.history.replaceState({}, '', tabPaths.dashboard);
    let pops = 0;
    const onPop = () => { pops += 1; };
    window.addEventListener('popstate', onPop);
    navigateToTab('dashboard');
    expect(pops).toBe(0);
    navigateToTab('sdrMetrics');
    expect(pops).toBe(1);
    expect(window.location.pathname).toBe(tabPaths.sdrMetrics);
    window.removeEventListener('popstate', onPop);
  });
});
