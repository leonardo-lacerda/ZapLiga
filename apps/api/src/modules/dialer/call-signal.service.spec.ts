import { CallSignalService } from './call-signal.service';
import { canaryCodec } from './dialer.rules';

describe('CallSignalService', () => {
  const make = (call: Record<string, unknown> | undefined) => {
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.startsWith('SELECT id, tenant_id FROM whatsapp_numbers')) return { rows: [{ id: 'n1', tenant_id: 't1' }] };
        if (sql.includes('FROM calls')) return { rows: call ? [call] : [] };
        return { rows: [] };
      }),
    };
    return { service: new CallSignalService(db as any, {} as any), db };
  };
  const insert = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO call_signal_events'));

  it('stores an answer to our offer with its kind and the ms since the offer', async () => {
    const { service, db } = make({ id: 'call-1', offer_sent_at: new Date(Date.now() - 1500).toISOString() });

    await service.store('s1', 'incoming_call', { data: { call_id: 'WA1', action: 'PreAccept { call_id: "WA1" }' } });

    const [, params] = insert(db);
    expect(params.slice(0, 5)).toEqual(['t1', 'n1', 'call-1', 'WA1', 'call_preaccept']);
    expect(params[5]).toBeGreaterThanOrEqual(1500);
  });

  it('ties a logout right after an offer to that call', async () => {
    const { service, db } = make({ id: 'call-2', offer_sent_at: new Date(Date.now() - 1400).toISOString(), waxum_call_id: 'WA2' });

    await service.store('s1', 'logged_out', { data: { conflict: 'device_removed' } });

    expect(insert(db)[1].slice(0, 5)).toEqual(['t1', 'n1', 'call-2', 'WA2', 'logged_out']);
  });

  it('keeps a session event with no recent offer, without a call', async () => {
    const { service, db } = make(undefined);

    await service.store('s1', 'stream_error', { data: { code: '515' } });

    expect(insert(db)[1].slice(0, 6)).toEqual(['t1', 'n1', null, null, 'stream_error', null]);
  });
});

describe('canaryCodec', () => {
  it('splits the lines between MLow and Opus, always the same for a line', () => {
    expect(canaryCodec('ab')).toBe(canaryCodec('ab'));
    expect(new Set(['a', 'b', 'c', 'd'].map(canaryCodec))).toEqual(new Set(['mlow', 'opus']));
  });
});
