import { NumbersService } from './numbers.service';

const number = { id: 'n1', tenant_id: 't1', label: 'numero 1', status: 'disconnected', waxum_session_id: 's1' };

const build = (waxum: Record<string, jest.Mock>) => {
  const db = { query: jest.fn(async () => ({ rows: [number] })) };
  const service = new NumbersService(db as any, waxum as any, {} as any, {} as any, {} as any, {} as any);
  return { service, db };
};

describe('NumbersService QR code', () => {
  it('starts the pairing of a session WhatsApp logged out before asking for the QR', async () => {
    const calls: string[] = [];
    const waxum = {
      getStatus: jest.fn(async () => {
        calls.push('status');
        return { status: 'disconnected', is_logged_in: false, socket_alive: false };
      }),
      reconnect: jest.fn(async () => {
        calls.push('connect');
        return {};
      }),
      getQr: jest.fn(async () => {
        calls.push('qr');
        return { status: 'waiting_for_qr', qr_codes: ['2@abc'], timeout_seconds: 60 };
      }),
    };
    const { service } = build(waxum);

    const payload = await service.qr('t1', 'n1');

    expect(payload.qr_codes).toEqual(['2@abc']);
    expect(waxum.reconnect).toHaveBeenCalledWith('s1');
    expect(calls.slice(0, 3)).toEqual(['status', 'connect', 'qr']);
  });

  describe('call block after pairing', () => {
    const pairing = () => ({
      getStatus: jest.fn(async () => ({ status: 'connecting', is_logged_in: false, socket_alive: true })),
      reconnect: jest.fn(),
      getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@abc'], timeout_seconds: 60 })),
    });

    it('keeps a line created with the block out of the dialer for 24 h when it shows a pairing QR', async () => {
      const db = { query: jest.fn(async () => ({ rows: [{ ...number, block_calls_after_pairing: true }] })) };
      const service = new NumbersService(db as any, pairing() as any, {} as any, {} as any, {} as any, {} as any);

      await service.qr('t1', 'n1');

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET flagged_until = GREATEST(flagged_until'), [24, 'n1', 't1']);
    });

    it('leaves a line created before the block free to call after pairing', async () => {
      const { service, db } = build(pairing());

      await service.qr('t1', 'n1');

      expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('flagged_until'), expect.anything());
    });
  });

  it('leaves a session that is already pairing alone', async () => {
    const waxum = {
      getStatus: jest.fn(async () => ({ status: 'connecting', is_logged_in: false, socket_alive: true })),
      reconnect: jest.fn(),
      getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@abc'], timeout_seconds: 60 })),
    };
    const { service } = build(waxum);

    await service.qr('t1', 'n1');

    expect(waxum.reconnect).not.toHaveBeenCalled();
  });

  it('reports a connected number without starting a new pairing', async () => {
    const waxum = {
      getStatus: jest.fn(async () => ({ status: 'connected', is_logged_in: true, socket_alive: true, phone_number: '5527997096501' })),
      reconnect: jest.fn(),
      getQr: jest.fn(async () => ({ status: 'connected', qr_codes: [] })),
    };
    jest.useFakeTimers();
    const { service, db } = build(waxum);

    const pending = service.qr('t1', 'n1');
    await jest.runAllTimersAsync();
    const payload = await pending;
    jest.useRealTimers();

    expect(waxum.reconnect).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ status: 'connected', phone_number: '5527997096501' });
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('flagged_until'), expect.anything());
  });

  it('starts the pairing over on a working PC when the PC of the line passes no internet', async () => {
    const onDeadPc = { ...number, waxum_node: 'edge-3' };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM egress_pcs WHERE slot')) return { rows: [] };
        if (sql.includes('SELECT p.slot')) return { rows: [{ slot: 'edge-2' }] };
        if (sql.startsWith('UPDATE whatsapp_numbers SET waxum_node')) return { rows: [{ ...onDeadPc, waxum_node: 'edge-2', waxum_session_id: 's2' }] };
        return { rows: [onDeadPc] };
      }),
    };
    const redis = { client: { ttl: jest.fn(async () => -2) }, acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
    const waxum = {
      getStatus: jest.fn(async () => ({ status: 'waiting_for_qr', is_logged_in: false, socket_alive: true })),
      createSession: jest.fn(async () => ({ id: 's2' })),
      deleteSession: jest.fn(async () => ({})),
      reconnect: jest.fn(),
      getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@new'], timeout_seconds: 60 })),
    };
    const service = new NumbersService(db as any, waxum as any, {} as any, redis as any, {} as any, {} as any);

    const payload = await service.qr('t1', 'n1');

    expect(waxum.createSession).toHaveBeenCalledWith('numero 1', 'edge-2');
    expect(waxum.deleteSession).toHaveBeenCalledWith('s1');
    expect(waxum.getQr).toHaveBeenCalledWith('s2');
    expect(payload.qr_codes).toEqual(['2@new']);
  });
});
