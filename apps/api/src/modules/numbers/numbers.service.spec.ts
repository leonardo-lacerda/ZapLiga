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
    const { service } = build(waxum);

    const pending = service.qr('t1', 'n1');
    await jest.runAllTimersAsync();
    const payload = await pending;
    jest.useRealTimers();

    expect(waxum.reconnect).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ status: 'connected', phone_number: '5527997096501' });
  });
});
