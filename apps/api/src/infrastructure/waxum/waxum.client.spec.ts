import { WaxumClient } from './waxum.client';

// The request bodies a line without camouflage sends must stay byte for byte the ones Waxum always
// got (docs/stealth-profile.md); the identity only rides next to them.
describe('WaxumClient session requests', () => {
  const env = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.WAXUM_URL = 'http://waxum:3451';
    process.env.WAXUM_EDGE_NODES = 'edge-1=http://edge-1:3451';
    process.env.WAXUM_REQUEST_INTERVAL_MS = '0';
    fetchMock = jest.fn(async () => new Response(JSON.stringify({ session: { id: 's1' }, code: 'ABCD1234', timeout_seconds: 60 }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { process.env = { ...env }; });

  const make = () => new WaxumClient({ query: jest.fn(async () => ({ rows: [{ waxum_node: 'edge-1' }] })) } as any);
  const bodies = () => fetchMock.mock.calls.map(([, init]: [string, RequestInit]) => init.body);
  const identity = { device: { os: 'Windows', platform: 'edge' }, client_profile: { locale: 'pt_BR' } };

  it('sends the same bodies as before without an identity', async () => {
    const client = make();

    await client.createSession('Linha', 'edge-1');
    await client.adoptSession('s1', 'Linha', 'edge-1');
    await client.pairCode('s1', '5527999990000');
    await client.reconnect('s1');

    expect(bodies()).toEqual([
      '{"name":"Linha"}',
      '{"id":"s1","name":"Linha","reuse":true}',
      '{"phone_number":"5527999990000"}',
      '{}',
    ]);
  });

  it('adds the identity next to each request own fields', async () => {
    const client = make();

    await client.createSession('Linha', 'edge-1', identity);
    await client.adoptSession('s1', 'Linha', 'edge-1', identity);
    await client.pairCode('s1', '5527999990000', identity);
    await client.reconnect('s1', { client_profile: { reset: true } });

    expect(bodies().map((body) => JSON.parse(String(body)))).toEqual([
      { name: 'Linha', ...identity },
      { id: 's1', name: 'Linha', reuse: true, ...identity },
      { phone_number: '5527999990000', ...identity },
      { client_profile: { reset: true } },
    ]);
  });
});
