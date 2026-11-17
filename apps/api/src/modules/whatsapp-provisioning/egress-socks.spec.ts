import { egressSocksConfig, parseSocksAddress, socksProxiesFor } from './egress-socks';

describe('egress SOCKS gateway config', () => {
  it('needs both the public host and the password', () => {
    expect(egressSocksConfig({})).toBeNull();
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: 'vps.example.com' })).toBeNull();
    expect(egressSocksConfig({ EGRESS_SOCKS_PASSWORD: 'secret' })).toBeNull();
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: '  ', EGRESS_SOCKS_PASSWORD: 'secret' })).toBeNull();
  });

  it('defaults to port 1080 and socks-gateway:1080 inside', () => {
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: '209.50.229.249', EGRESS_SOCKS_PASSWORD: 'secret' })).toEqual({
      publicHost: '209.50.229.249', port: 1080, password: 'secret', internalHost: 'socks-gateway', internalPort: 1080,
    });
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: 'h', EGRESS_SOCKS_PASSWORD: 'p', EGRESS_SOCKS_PORT: 'abc' })?.port).toBe(1080);
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: 'h', EGRESS_SOCKS_PASSWORD: 'p', EGRESS_SOCKS_PORT: '70000' })?.port).toBe(1080);
    expect(egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: 'h', EGRESS_SOCKS_PASSWORD: 'p', EGRESS_SOCKS_PORT: '21080' })?.port).toBe(21080);
  });

  it('parses the internal address with or without a scheme', () => {
    expect(parseSocksAddress('socks-gateway:1080')).toEqual({ host: 'socks-gateway', port: 1080 });
    expect(parseSocksAddress('socks5://gw.internal:1090')).toEqual({ host: 'gw.internal', port: 1090 });
    expect(parseSocksAddress('socks5h://gw.internal')).toEqual({ host: 'gw.internal', port: 1080 });
    expect(parseSocksAddress('[fd00::1]:1081')).toEqual({ host: 'fd00::1', port: 1081 });
  });

  it('uses the PC slot as the proxy user on both addresses', () => {
    const config = egressSocksConfig({ EGRESS_SOCKS_PUBLIC_HOST: 'vps.example.com', EGRESS_SOCKS_PASSWORD: 'secret', EGRESS_SOCKS_PORT: '2080' })!;
    expect(socksProxiesFor(config, 'edge-2')).toEqual({
      proxy: { typeId: 1, server: 'vps.example.com', port: 2080, username: 'edge-2', password: 'secret' },
      probeProxy: { server: 'socks-gateway', port: 1080, username: 'edge-2', password: 'secret' },
    });
  });
});
