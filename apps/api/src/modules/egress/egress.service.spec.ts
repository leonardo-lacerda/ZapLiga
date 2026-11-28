import { EgressService, REPORT_STALE_SECONDS } from './egress.service';

describe('EgressService PC exits', () => {
  const rows = [
    { id: 'pc-1', name: 'PC da Ana', slot: 'edge-1', online: true },
    { id: 'pc-2', name: 'PC do Bruno', slot: 'edge-2', online: null },
  ];
  const proxies = [{ slot: 'proxy-1', name: 'Roundproxies', online: true }];
  const make = () => {
    const db = { query: jest.fn(async (sql: string, params: unknown[]) => (sql.includes('FROM egress_proxies') ? { rows: proxies } : { rows: params[1] ? rows.filter((row) => row.id === params[1]) : rows })) };
    return { db, service: new EgressService(db as any, { record: jest.fn() } as any, {} as any) };
  };

  it('lists the PCs with a slot by id, with the same online rule as the line exits', async () => {
    const { db, service } = make();

    expect(await service.pcExits()).toEqual([
      { id: 'pc-1', name: 'PC da Ana', slot: 'edge-1', online: true },
      { id: 'pc-2', name: 'PC do Bruno', slot: 'edge-2', online: false },
    ]);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("route = 'pc' AND route_reported_at > now() - make_interval(secs => $1)");
    expect(sql).toContain('slot IS NOT NULL');
    expect(params).toEqual([REPORT_STALE_SECONDS, null]);
  });

  it('finds one PC by id', async () => {
    const { db, service } = make();
    expect(await service.pcExits('pc-2')).toEqual([{ id: 'pc-2', name: 'PC do Bruno', slot: 'edge-2', online: false }]);
    expect(db.query.mock.calls[0][1]).toEqual([REPORT_STALE_SECONDS, 'pc-2']);
  });

  it('offers PC and proxy slots as exits, never the VPS', async () => {
    const { service } = make();
    expect(await service.nodes()).toEqual({ items: [
      { node: 'edge-1', label: 'PC da Ana', online: true },
      { node: 'edge-2', label: 'PC do Bruno', online: false },
      { node: 'proxy-1', label: 'Proxy: Roundproxies', online: true },
    ] });
  });
});

describe('EgressService PC history', () => {
  const previous = process.env.WAXUM_EDGE_NODES;
  beforeAll(() => { process.env.WAXUM_EDGE_NODES = 'edge-1=http://edge-1:3451'; });
  afterAll(() => { process.env.WAXUM_EDGE_NODES = previous; });

  const make = () => {
    const db = { query: jest.fn(async (sql: string, _params?: unknown[]) => (sql.includes('UPDATE egress_pcs') ? { rows: [{ id: 'pc-1', name: 'PC do Leo', tailscale_ip: '100.64.0.2' }] } : { rows: [] })) };
    const service = new EgressService(db as any, { record: jest.fn() } as any, {} as any);
    jest.spyOn(service, 'syncPcs').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'edgeKey').mockResolvedValue('');
    return { db, service };
  };
  const eventCall = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO egress_pc_events'));

  it('records the PC going online only when its last event was not online', async () => {
    const { db, service } = make();
    await service.slotConfig('edge-1', 'pc', true);
    const [sql, params] = eventCall(db)!;
    expect(params).toEqual(['pc-1', 'edge-1', 'PC do Leo', 'online']);
    expect(sql).toContain("COALESCE((SELECT kind FROM last), '') <> 'online'");
  });

  it('records the PC going offline only after it was online', async () => {
    const { db, service } = make();
    await service.slotConfig('edge-1', 'offline', true);
    const [sql, params] = eventCall(db)!;
    expect(params[3]).toBe('offline');
    expect(sql).toContain("COALESCE((SELECT kind FROM last), 'online') = 'online'");
  });

  it('records a slot that stopped reporting once, as silent', async () => {
    const { db, service } = make();
    await service.recordSilentPcs();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("'silent'");
    expect(sql).toContain("ORDER BY e.occurred_at DESC LIMIT 1) = 'online'");
    expect(params).toEqual([REPORT_STALE_SECONDS]);
  });
});
