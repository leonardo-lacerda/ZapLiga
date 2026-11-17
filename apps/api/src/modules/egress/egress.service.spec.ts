import { EgressService, REPORT_STALE_SECONDS } from './egress.service';

describe('EgressService PC exits', () => {
  const rows = [
    { id: 'pc-1', name: 'PC da Ana', slot: 'edge-1', online: true },
    { id: 'pc-2', name: 'PC do Bruno', slot: 'edge-2', online: null },
  ];
  const make = () => {
    const db = { query: jest.fn(async (_sql: string, params: unknown[]) => ({ rows: params[1] ? rows.filter((row) => row.id === params[1]) : rows })) };
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

  it('keeps nodes() as the VPS plus every PC slot', async () => {
    const { service } = make();
    expect(await service.nodes()).toEqual({ items: [
      { node: 'main', label: 'VPS', online: true },
      { node: 'edge-1', label: 'PC da Ana', online: true },
      { node: 'edge-2', label: 'PC do Bruno', online: false },
    ] });
  });
});
