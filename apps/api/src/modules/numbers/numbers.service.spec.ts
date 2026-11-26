import { NumbersService } from './numbers.service';

const number = { id: 'n1', tenant_id: 't1', label: 'numero 1', status: 'disconnected', waxum_session_id: 's1', online: true };

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

  describe('pairing', () => {
    const pairing = () => ({
      getStatus: jest.fn(async () => ({ status: 'connecting', is_logged_in: false, socket_alive: true })),
      reconnect: jest.fn(),
      getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@abc'], timeout_seconds: 60 })),
    });
    const pairingUpdate = (db: { query: jest.Mock }) => db.query.mock.calls.find(([sql]: [string]) => sql.includes('SET last_paired_at = now()'));

    it('puts the line back on the canary and marks it young when it shows a pairing QR', async () => {
      const { service, db } = build(pairing());

      await service.qr('t1', 'n1');

      const [sql, params] = pairingUpdate(db);
      expect(sql).toContain("canary_status = 'pending'");
      expect(sql).toContain('loss_reason = NULL');
      expect(params).toEqual([24, 'n1', 't1']);
    });

    it('keeps the 24 h block only for lines created with it', async () => {
      const { service, db } = build(pairing());

      await service.qr('t1', 'n1');

      expect(pairingUpdate(db)[0]).toContain('flagged_until = CASE WHEN block_calls_after_pairing THEN GREATEST(flagged_until, now() + make_interval(hours => $1)) ELSE flagged_until END');
    });

    it('refuses a new QR for a line WhatsApp took away twice', async () => {
      const db = { query: jest.fn(async () => ({ rows: [{ ...number, removal_count: 2 }] })) };
      const waxum = pairing();
      const service = new NumbersService(db as any, waxum as any, {} as any, {} as any, {} as any, {} as any);

      await expect(service.qr('t1', 'n1')).rejects.toThrow('Linha aposentada');
      expect(waxum.getQr).not.toHaveBeenCalled();
    });
  });

  describe('canary message', () => {
    const entitlement = { assertAction: jest.fn(async () => undefined) };
    const audit = { record: jest.fn(async () => undefined) };
    const make = (line: Record<string, unknown>, phones: string[]) => {
      const db = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('unnest(ds.canary_phones)')) return { rows: phones.map((phone) => ({ phone })) };
          return { rows: [{ ...number, status: 'connected', canary_status: 'pending', ...line }] };
        }),
      };
      const waxum = { sendText: jest.fn(async () => ({ status: 'sent' })) };
      return { service: new NumbersService(db as any, waxum as any, audit as any, {} as any, entitlement as any, {} as any), waxum };
    };

    it('texts the least used team phone from the line and returns it', async () => {
      const { service, waxum } = make({}, ['5527999990000']);

      expect(await service.sendCanaryMessage('t1', 'u1', 'n1')).toEqual({ phone: '5527999990000' });
      expect(waxum.sendText).toHaveBeenCalledWith('s1', '5527999990000', expect.any(String));
    });

    it('asks for the team phones when none is configured', async () => {
      const { service, waxum } = make({}, []);

      await expect(service.sendCanaryMessage('t1', 'u1', 'n1')).rejects.toThrow('Cadastre os celulares da equipe');
      expect(waxum.sendText).not.toHaveBeenCalled();
    });

    it('refuses a line that already passed or is still blocked', async () => {
      await expect(make({ canary_status: 'passed' }, ['5527999990000']).service.sendCanaryMessage('t1', 'u1', 'n1')).rejects.toThrow('já passou');
      await expect(make({ flagged_until: new Date(Date.now() + 60_000).toISOString() }, ['5527999990000']).service.sendCanaryMessage('t1', 'u1', 'n1')).rejects.toThrow('bloqueada');
    });
  });

  it('never moves a line to the VPS', async () => {
    const redis = { acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
    const service = new NumbersService({ query: jest.fn() } as any, {} as any, {} as any, redis as any, {} as any, {} as any);

    await expect(service.moveToWaxumNode('t1', null, 'n1', 'main')).rejects.toThrow('não podem sair pela VPS');
    expect(redis.acquireLock).not.toHaveBeenCalled();
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
        if (sql.includes('AS online')) return { rows: [{ online: false }] };
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

describe('NumbersService passCanary', () => {
  it('releases the line, records a human canary_passed event and tells the CRM', async () => {
    const db = { query: jest.fn(async (sql: string) => (sql.startsWith('UPDATE') ? { rows: [{ id: 'n1', canary_status: 'passed' }] } : { rows: [] })) };
    const audit = { record: jest.fn(async () => undefined) };
    const crmEvents = { recordLine: jest.fn(async () => undefined) };
    const entitlement = { assertAction: jest.fn(async () => undefined) };
    const service = new NumbersService(db as any, {} as any, audit as any, {} as any, entitlement as any, {} as any, crmEvents as any);

    await expect(service.passCanary('t1', 'u1', 'n1', 'aquecida à mão')).resolves.toMatchObject({ canary_status: 'passed' });

    const [, params] = db.query.mock.calls.find(([sql]: [string]) => sql.includes('number_health_events')) as unknown as [string, unknown[]];
    expect(params).toEqual(['t1', 'n1', JSON.stringify({ manual: true, reason: 'aquecida à mão' })]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'number.canary_passed', entityId: 'n1' }));
    expect(crmEvents.recordLine).toHaveBeenCalledWith('t1', 'n1', 'number.updated');
  });
});
