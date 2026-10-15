import { encryptSecret, webhookSignature } from '../lead-ingestion/lead-ingestion.crypto';
import { CrmEventsService, nextDelaySeconds } from './crm-events.service';

const callRow = {
  id: 'call-1', tenant_id: 'tenant-1', integration_id: 'int-1', status: 'completed', source: 'manual', lead_id: 'lead-1', lead_phone: '5511999990000', lead_name: 'Ana',
  number_id: 'num-1', number_label: 'Comercial 1', number_phone: '5585900000000', number_last_call_ended_at: null, number_flagged_until: null,
  sdr_id: 'sdr-1', sdr_name: 'Leo', external_user_id: '12', external_ref: { call_id: 'f-1' }, connected_duration_seconds: 42,
};

const makeService = (handler: (sql: string, params: unknown[]) => any = () => ({ rows: [] })) => {
  const db = { query: jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params) ?? { rows: [] }) };
  return { service: new CrmEventsService(db as any), db };
};

const inserts = (db: { query: jest.Mock }) => db.query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO crm_integration_events'));

describe('CrmEventsService recording', () => {
  it('records a call event once per call and type, with the full call', async () => {
    const { service, db } = makeService((sql) => sql.includes('FROM calls c') ? { rows: [callRow] } : undefined);
    await service.recordCall('tenant-1', 'call-1', 'call.ended');
    const [, params] = inserts(db)[0];
    expect(params.slice(1, 5)).toEqual(['tenant-1', 'int-1', 'call.ended', 'call.ended:call-1']);
    const envelope = JSON.parse(String(params[5]));
    expect(envelope).toMatchObject({ type: 'call.ended', schemaVersion: 1, tenantId: 'tenant-1', integrationId: 'int-1' });
    expect(envelope.payload.call).toMatchObject({ id: 'call-1', to_phone: '5511999990000', lead_name: 'Ana', number: { label: 'Comercial 1' }, sdr: { external_user_id: '12' }, external_ref: { call_id: 'f-1' }, connected_duration_seconds: 42 });
  });

  it('records nothing for calls that no connected integration placed', async () => {
    const { service, db } = makeService();
    await service.recordCall('tenant-1', 'call-9', 'call.reserved');
    expect(inserts(db)).toHaveLength(0);
  });

  it('fans a line event out to every connected integration of the tenant', async () => {
    const { service, db } = makeService((sql) => {
      if (sql.includes('FROM crm_integrations')) return { rows: [{ id: 'int-1' }, { id: 'int-2' }] };
      if (sql.includes('FROM whatsapp_numbers n')) return { rows: [{ id: 'num-1', label: 'Comercial 1', status: 'disconnected', active_calls: 0 }] };
      return undefined;
    });
    await service.recordLine('tenant-1', 'num-1', 'number.status_changed');
    expect(inserts(db).map(([, params]) => params[2])).toEqual(['int-1', 'int-2']);
    expect(JSON.parse(String(inserts(db)[0][1][5])).payload.number).toMatchObject({ id: 'num-1', status: 'disconnected', in_call: false });
  });

  it('skips the line lookup when the tenant has no connected integration', async () => {
    const { service, db } = makeService();
    await service.recordLine('tenant-1', 'num-1', 'number.removed');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('CrmEventsService delivery', () => {
  const secret = 'zpl_whsec_test';
  const pending = { id: 'evt-1', tenant_id: 'tenant-1', integration_id: 'int-1', event_type: 'call.ended', idempotency_key: 'call.ended:call-1', payload: { id: 'evt-1', type: 'call.ended' }, attempts: 0 };
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const makeDelivery = (row = pending) => makeService((sql) => {
    if (sql.startsWith('UPDATE crm_integration_events SET locked_until')) return { rows: [row] };
    if (sql.startsWith('SELECT webhook_url')) return { rows: [{ webhook_url: 'https://franco.example.com/webhooks/zapcall/tok', webhook_secret_ciphertext: encryptSecret(secret) }] };
    return undefined;
  });
  const updateOf = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE crm_integration_events SET status'));

  it('posts the event signed with the integration secret and marks it delivered', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetchMock as any;
    const { service, db } = makeDelivery();
    await service.flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://franco.example.com/webhooks/zapcall/tok');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-zapliga-event-type']).toBe('call.ended');
    expect(headers['x-zapliga-signature']).toBe(`sha256=${webhookSignature(secret, headers['x-zapliga-timestamp'], Buffer.from(init.body))}`);
    expect(String(updateOf(db)?.[0])).toContain("status = 'delivered'");
  });

  it('treats an error or a redirect as a failure and schedules a retry', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 302 }) as any;
    const { service, db } = makeDelivery();
    await service.flush();
    const [sql, params] = updateOf(db)!;
    expect(String(sql)).toContain("CASE WHEN $2::int >= $3::int THEN 'dead_letter' ELSE 'pending' END");
    expect(params).toEqual(['evt-1', 1, 10, 2, 302, 'HTTP 302']);
  });

  it('dead-letters after the last attempt', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    const { service, db } = makeDelivery({ ...pending, attempts: 9 });
    await service.flush();
    const [, params] = updateOf(db)!;
    expect(params[1]).toBe(10);
    expect(params[2]).toBe(10);
  });

  it('backs off exponentially up to fifteen minutes', () => {
    expect([1, 2, 5, 9, 10].map(nextDelaySeconds)).toEqual([2, 4, 32, 512, 900]);
  });
});
