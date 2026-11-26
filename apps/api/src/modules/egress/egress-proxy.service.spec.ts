jest.mock('node:dns', () => ({ promises: { resolve4: jest.fn(async () => ['203.0.113.9', '203.0.113.2']) } }));
process.env.WAXUM_EDGE_NODES = 'edge-1=http://tailscale-edge-1:3451,proxy-1=http://proxy-edge-1:3451';
import { encryptSecret } from '../lead-ingestion/lead-ingestion.crypto';
import { EgressProxyService, parseProxy } from './egress-proxy.service';

describe('parseProxy', () => {
  it("takes the provider's host:port:user:password and a socks5 URL", () => {
    expect(parseProxy('us.roundproxies.com:5002:client-1-udp-true-session-a:p:ss')).toEqual({ host: 'us.roundproxies.com', port: 5002, user: 'client-1-udp-true-session-a', password: 'p:ss' });
    expect(parseProxy('socks5://user%40x:secret@1.2.3.4:1080')).toEqual({ host: '1.2.3.4', port: 1080, user: 'user@x', password: 'secret' });
  });

  it('refuses anything without host, port, user and password', () => {
    expect(() => parseProxy('us.roundproxies.com:5002')).toThrow('Cole a proxy');
    expect(() => parseProxy('host:99999:user:pass')).toThrow('Proxy inválida');
  });
});

describe('EgressProxyService', () => {
  const audit = { record: jest.fn(async () => undefined) };

  it('hands the slot its proxy with the host resolved to the lowest IPv4', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ proxy_url_encrypted: encryptSecret('socks5://u%3Ax:p%40ss@us.roundproxies.com:5002') }] })) };
    const service = new EgressProxyService(db as any, audit as any);

    expect(await service.slotConfig('proxy-1')).toBe('proxy=socks5://u%3Ax:p%40ss@203.0.113.2:5002\n');
    await expect(service.slotConfig('edge-1')).rejects.toThrow('não existe');
  });

  it('answers an empty proxy to a slot with none, so it stays without internet', async () => {
    const service = new EgressProxyService({ query: jest.fn(async () => ({ rows: [] })) } as any, audit as any);
    expect(await service.slotConfig('proxy-1')).toBe('proxy=\n');
  });

  const report = { route: 'proxy', rxBytes: 1000, txBytes: 500, udpRxBytes: 300, udpTxBytes: 200, exitIp: '131.255.22.16', udpOk: true, latencyMs: 450, error: '' };
  const make = (before: Record<string, unknown>, lines: Array<{ id: string }>) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT route, exit_ip')) return { rows: [before] };
        if (sql.startsWith('SELECT id FROM whatsapp_numbers')) return { rows: lines };
        return { rows: [] };
      }),
    };
    return { service: new EgressProxyService(db as any, audit as any), db: db as unknown as { query: jest.Mock } };
  };
  const call = (db: { query: jest.Mock }, fragment: string) => db.query.mock.calls.find(([sql]: [string]) => sql.includes(fragment));

  it("adds the report's bytes to the line's day and keeps the status", async () => {
    const { service, db } = make({ route: 'proxy', exit_ip: '131.255.22.16' }, [{ id: 'n1' }]);

    await service.report('proxy-1', report);

    const [, params] = call(db, 'INSERT INTO egress_proxy_usage');
    expect(params).toEqual(['proxy-1', 'America/Sao_Paulo', 'n1', 1000, 500, 300, 200]);
    expect(call(db, 'egress_proxy_events')).toBeUndefined();
  });

  it('records an exit IP change and the proxy coming back', async () => {
    const { service, db } = make({ route: 'offline', exit_ip: '131.255.23.22' }, []);

    await service.report('proxy-1', report);

    const calls = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
    const kinds = calls.filter(([sql]) => sql.includes('INSERT INTO egress_proxy_events')).map(([sql, params]) => (sql.includes("'ip_changed'") ? 'ip_changed' : params[1]));
    expect(kinds).toEqual(['ip_changed', 'up']);
    // No single line on the slot: the bytes stay on the slot.
    expect(call(db, 'INSERT INTO egress_proxy_usage')[1][2]).toBe('');
  });

  it('writes nothing to the usage when no byte moved', async () => {
    const { service, db } = make({ route: 'proxy', exit_ip: '131.255.22.16' }, [{ id: 'n1' }]);
    await service.report('proxy-1', { ...report, rxBytes: 0, txBytes: 0, udpRxBytes: 0, udpTxBytes: 0 });
    expect(call(db, 'INSERT INTO egress_proxy_usage')).toBeUndefined();
  });
});
