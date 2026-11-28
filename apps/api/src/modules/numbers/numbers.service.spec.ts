import { NumbersService } from './numbers.service';

const number = { id: 'n1', tenant_id: 't1', label: 'numero 1', status: 'disconnected', waxum_session_id: 's1', online: true };

const build = (waxum: Record<string, jest.Mock>) => {
  const db = { query: jest.fn(async () => ({ rows: [number] })) };
  const service = new NumbersService(db as any, waxum as any, {} as any, {} as any, {} as any, {} as any, {} as any);
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
    // A line without camouflage sends no identity.
    expect(waxum.reconnect).toHaveBeenCalledWith('s1', undefined);
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
      const service = new NumbersService(db as any, waxum as any, {} as any, {} as any, {} as any, {} as any, {} as any);

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
      return { service: new NumbersService(db as any, waxum as any, audit as any, {} as any, entitlement as any, {} as any, {} as any), waxum };
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

  describe('camouflage', () => {
    const profile = { version: 1, surface: 'WEB_BROWSER', device: { os: 'Windows', platform: 'edge' }, client: { locale: 'pt_BR' } };
    const stealthLine = { ...number, stealth_enabled: true, stealth_profile: profile, stealth_profile_frozen_at: '2026-11-26T12:00:00Z' };
    const identity = { device: { os: 'Windows', platform: 'edge' }, client_profile: { locale: 'pt_BR' } };

    const creating = () => {
      const client = { query: jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ id: 'n9' }] })) };
      const db = {
        query: jest.fn(async (sql: string) => (sql.includes('FROM egress_pcs') ? { rows: [{ slot: 'edge-2' }] } : { rows: [] })),
        transaction: jest.fn(async (run: (c: typeof client) => unknown) => run(client)),
      };
      const waxum = { createSession: jest.fn(async () => ({ id: 's9' })), deleteSession: jest.fn() };
      const redis = { client: { ttl: jest.fn(async () => -2) }, acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
      const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, redis as any, { assertAction: jest.fn(async () => undefined) } as any, { assertCanAddNumbers: jest.fn(async () => undefined) } as any, {} as any);
      const insertParams = () => client.query.mock.calls[0][1];
      return { service, waxum, insertParams };
    };

    it('creates a line with the switch on with its profile, frozen before its first QR', async () => {
      const { service, waxum, insertParams } = creating();

      await service.create('t1', 'u1', { label: 'Previtas 20', stealth: true });

      const [, , sent] = waxum.createSession.mock.calls[0] as unknown as [string, string, { device: { platform: string }; client_profile: { locale: string } }];
      expect(sent.client_profile).toEqual({ locale: 'pt_BR' });
      expect(JSON.parse(String(insertParams()[10]))).toMatchObject({ version: 1, device: { platform: sent.device.platform } });
    });

    it('creates a line without the switch exactly as before', async () => {
      const { service, waxum, insertParams } = creating();

      await service.create('t1', 'u1', { label: 'Previtas 21' });

      expect(waxum.createSession).toHaveBeenCalledWith('Previtas 21', 'edge-2', undefined);
      expect(insertParams()[10]).toBeNull();
    });

    it('logs a camouflaged line in with its identity', async () => {
      const db = { query: jest.fn(async () => ({ rows: [stealthLine] })) };
      const waxum = { reconnect: jest.fn(async () => ({})) };
      const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, {} as any, { assertAction: jest.fn(async () => undefined) } as any, {} as any, {} as any);

      await service.reconnect('t1', 'u1', 'n1');

      expect(waxum.reconnect).toHaveBeenCalledWith('s1', identity);
    });

    it('starts the pairing QR of a camouflaged line with its identity', async () => {
      const db = { query: jest.fn(async () => ({ rows: [stealthLine] })) };
      const waxum = {
        getStatus: jest.fn(async () => ({ status: 'disconnected', is_logged_in: false, socket_alive: false })),
        reconnect: jest.fn(async () => ({})),
        getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@abc'], timeout_seconds: 60 })),
      };
      const service = new NumbersService(db as any, waxum as any, {} as any, {} as any, {} as any, {} as any, {} as any);

      await service.qr('t1', 'n1');

      expect(waxum.reconnect).toHaveBeenCalledWith('s1', identity);
    });

    describe('moving a line whose source Waxum is unreachable', () => {
      const edgeNodes = process.env.WAXUM_EDGE_NODES;
      beforeEach(() => { process.env.WAXUM_EDGE_NODES = 'edge-1=http://edge-1:3451,edge-2=http://edge-2:3451'; });
      afterEach(() => { if (edgeNodes === undefined) delete process.env.WAXUM_EDGE_NODES; else process.env.WAXUM_EDGE_NODES = edgeNodes; });
      const moving = (adopt: jest.Mock) => {
        const db = {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('AS online')) return { rows: [{ online: true }] };
            if (sql.includes('FROM calls')) return { rows: [] };
            return { rows: [{ ...stealthLine, waxum_node: 'edge-1', status: 'connected' }] };
          }),
        };
        const waxum = {
          releaseSession: jest.fn(async () => { throw new Error('fetch failed'); }),
          adoptSession: adopt,
          statusOn: jest.fn(async () => ({ status: 'connected', is_logged_in: true, socket_alive: true })),
        };
        const redis = { acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
        const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, redis as any, {} as any, {} as any, {} as any);
        return { service, db, waxum };
      };

      it('opens the session on the target with the line identity', async () => {
        const { service, waxum } = moving(jest.fn(async () => ({})));

        await service.moveToWaxumNode('t1', null, 'n1', 'edge-2');

        expect(waxum.adoptSession).toHaveBeenCalledWith('s1', 'numero 1', 'edge-2', identity);
      });

      it('goes back to the source and marks the line disconnected when the target fails', async () => {
        const adopt = jest.fn(async (_session: string, _name: string, node: string) => { if (node === 'edge-2') throw new Error('Waxum 500'); return {}; });
        const { service, db } = moving(adopt);

        await expect(service.moveToWaxumNode('t1', null, 'n1', 'edge-2')).rejects.toThrow('Waxum 500');
        expect(adopt).toHaveBeenLastCalledWith('s1', 'numero 1', 'edge-1', identity);
        expect(db.query).toHaveBeenCalledWith("UPDATE whatsapp_numbers SET status = 'disconnected' WHERE id = $1", ['n1']);
      });
    });
  });

  describe('new camouflage (#5, docs/device-profile.md)', () => {
    const android = { os_version: '16', manufacturer: 'OPPO', device: 'Find X8 Pro', mcc: '000', mnc: '000', phone_id: '5f0c2b8e-3a1d-4c55-9a0e-2f6b7c1d9e10', business: true };
    const deviceProfile = { version: 1, surface: 'ANDROID_PHONE', source: { multilogin_phone_id: 'ml-1', name: 'Previtas 30' }, android, client: { locale: 'pt_BR' } };
    const newCamouflage = { device: { os: 'Android', platform: 'android_phone' }, client_profile: { locale: 'pt_BR', android } };
    const chosenLine = { ...number, status: 'disconnected', device_profile_enabled: true, device_profile_active: false, multilogin_phone_id: 'ml-1', device_profile: deviceProfile, device_profile_frozen_at: '2026-11-27T12:00:00Z' };

    it('creates a line born as the chosen cloud phone', async () => {
      const client = { query: jest.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ id: 'n9' }] })) };
      const db = {
        query: jest.fn(async (sql: string) => (sql.includes('FROM egress_pcs') ? { rows: [{ slot: 'edge-2' }] } : { rows: [] })),
        transaction: jest.fn(async (run: (c: typeof client) => unknown) => run(client)),
      };
      const waxum = { createSession: jest.fn(async () => ({ id: 's9' })), deleteSession: jest.fn() };
      const redis = { client: { ttl: jest.fn(async () => -2) }, acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
      const deviceProfiles = { profileFor: jest.fn(async () => deviceProfile) };
      const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, redis as any, { assertAction: jest.fn(async () => undefined) } as any, { assertCanAddNumbers: jest.fn(async () => undefined) } as any, deviceProfiles as any);

      await service.create('t1', 'u1', { label: 'Previtas 30', multiloginPhoneId: 'ml-1', business: true });

      expect(deviceProfiles.profileFor).toHaveBeenCalledWith('ml-1', true);
      expect(waxum.createSession).toHaveBeenCalledWith('Previtas 30', 'edge-2', newCamouflage);
      const params = client.query.mock.calls[0][1];
      expect(JSON.parse(String(params[11]))).toEqual(deviceProfile);
      expect(params[12]).toBe('ml-1');
    });

    it('asks whether the number is WhatsApp or WhatsApp Business', async () => {
      const service = new NumbersService({} as any, {} as any, {} as any, {} as any, { assertAction: jest.fn(async () => undefined) } as any, {} as any, {} as any);

      await expect(service.create('t1', 'u1', { label: 'Previtas 32', multiloginPhoneId: 'ml-1' })).rejects.toThrow('WhatsApp Business');
    });

    it('refuses both camouflages on one line', async () => {
      const service = new NumbersService({} as any, {} as any, {} as any, {} as any, { assertAction: jest.fn(async () => undefined) } as any, {} as any, {} as any);

      await expect(service.create('t1', 'u1', { label: 'Previtas 31', stealth: true, multiloginPhoneId: 'ml-1' })).rejects.toThrow('só uma camuflagem');
    });

    it('keeps a chosen line as it is on reconnects until it pairs again', async () => {
      const db = { query: jest.fn(async () => ({ rows: [chosenLine] })) };
      const waxum = { reconnect: jest.fn(async () => ({})) };
      const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, {} as any, { assertAction: jest.fn(async () => undefined) } as any, {} as any, {} as any);

      await service.reconnect('t1', 'u1', 'n1');

      expect(waxum.reconnect).toHaveBeenCalledWith('s1', { client_profile: { reset: true } });
    });

    it('pairs a chosen line by code as the cloud phone and records it', async () => {
      const db = { query: jest.fn(async (sql: string) => (sql.includes('AS online') ? { rows: [{ online: true }] } : { rows: [chosenLine] })) };
      const waxum = { pairCode: jest.fn(async () => ({ code: 'ABCD1234', timeout_seconds: 180 })) };
      const service = new NumbersService(db as any, waxum as any, { record: jest.fn(async () => undefined) } as any, {} as any, { assertAction: jest.fn(async () => undefined) } as any, {} as any, {} as any);

      await service.pairCode('t1', 'u1', 'n1', '5527999990000');

      expect(waxum.pairCode).toHaveBeenCalledWith('s1', '5527999990000', newCamouflage);
      expect(db.query).toHaveBeenCalledWith('UPDATE whatsapp_numbers SET device_profile_active = $2 WHERE id = $1', ['n1', true]);
    });
  });

  it('never moves a line to the VPS', async () => {
    const redis = { acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
    const service = new NumbersService({ query: jest.fn() } as any, {} as any, {} as any, redis as any, {} as any, {} as any, {} as any);

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
    const service = new NumbersService(db as any, waxum as any, {} as any, redis as any, {} as any, {} as any, {} as any);

    const payload = await service.qr('t1', 'n1');

    expect(waxum.createSession).toHaveBeenCalledWith('numero 1', 'edge-2', undefined);
    expect(waxum.deleteSession).toHaveBeenCalledWith('s1');
    expect(waxum.getQr).toHaveBeenCalledWith('s2');
    expect(payload.qr_codes).toEqual(['2@new']);
  });

  it('starts over on a working PC a line WhatsApp removed, even though its session still knows the phone', async () => {
    const lost = { ...number, waxum_node: 'edge-4', loss_reason: 'device_removed', phone: '5527999990011' };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('AS online')) return { rows: [{ online: false }] };
        if (sql.includes('SELECT p.slot')) return { rows: [{ slot: 'edge-1' }] };
        if (sql.startsWith('UPDATE whatsapp_numbers SET waxum_node')) return { rows: [{ ...lost, waxum_node: 'edge-1', waxum_session_id: 's2' }] };
        return { rows: [lost] };
      }),
    };
    const redis = { client: { ttl: jest.fn(async () => -2) }, acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => undefined) };
    const waxum = {
      getStatus: jest.fn(async () => ({ status: 'disconnected', phone_number: '5527999990011', is_logged_in: false })),
      createSession: jest.fn(async () => ({ id: 's2' })),
      deleteSession: jest.fn(async () => ({})),
      getQr: jest.fn(async () => ({ status: 'waiting_for_qr', qr_codes: ['2@new'], timeout_seconds: 60 })),
    };
    const service = new NumbersService(db as any, waxum as any, {} as any, redis as any, {} as any, {} as any, {} as any);

    await service.qr('t1', 'n1');

    expect(waxum.createSession).toHaveBeenCalledWith('numero 1', 'edge-1', undefined);
    expect(waxum.getQr).toHaveBeenCalledWith('s2');
  });
});

describe('NumbersService passCanary', () => {
  it('releases the line, records a human canary_passed event and tells the CRM', async () => {
    const db = { query: jest.fn(async (sql: string) => (sql.startsWith('UPDATE') ? { rows: [{ id: 'n1', canary_status: 'passed' }] } : { rows: [] })) };
    const audit = { record: jest.fn(async () => undefined) };
    const crmEvents = { recordLine: jest.fn(async () => undefined) };
    const entitlement = { assertAction: jest.fn(async () => undefined) };
    const service = new NumbersService(db as any, {} as any, audit as any, {} as any, entitlement as any, {} as any, {} as any, crmEvents as any);

    await expect(service.passCanary('t1', 'u1', 'n1', 'aquecida à mão')).resolves.toMatchObject({ canary_status: 'passed' });

    const [, params] = db.query.mock.calls.find(([sql]: [string]) => sql.includes('number_health_events')) as unknown as [string, unknown[]];
    expect(params).toEqual(['t1', 'n1', JSON.stringify({ manual: true, reason: 'aquecida à mão' })]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'number.canary_passed', entityId: 'n1' }));
    expect(crmEvents.recordLine).toHaveBeenCalledWith('t1', 'n1', 'number.updated');
  });
});

describe('NumbersService on a PC slot that is offline', () => {
  const env = process.env.WAXUM_EDGE_NODES;
  beforeAll(() => { process.env.WAXUM_EDGE_NODES = 'edge-1=http://edge-1:3451,edge-2=http://edge-2:3451'; });
  afterAll(() => { process.env.WAXUM_EDGE_NODES = env; });

  // edge-2's PC is offline; edge-1 is online (unless `freePc` is null).
  const setup = (waxum: Record<string, jest.Mock>, freePc: string | null = 'edge-1') => {
    const row: any = { id: 'n1', tenant_id: 't1', label: 'Telefone 1', status: 'waiting_for_qr', waxum_session_id: 's1', waxum_node: 'edge-2' };
    const db = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT p.slot')) return { rows: freePc ? [{ slot: freePc }] : [] };
        if (sql.includes('AS online')) return { rows: [{ online: params[0] === 'edge-1' }] };
        if (sql.startsWith('UPDATE whatsapp_numbers SET waxum_node = $1,')) { Object.assign(row, { waxum_node: params[0], waxum_session_id: params[1], status: 'disconnected' }); return { rows: [{ ...row }] }; }
        if (sql.startsWith('UPDATE whatsapp_numbers SET waxum_node')) { row.waxum_node = params[1]; return { rows: [{ ...row }] }; }
        return { rows: [{ ...row }] };
      }),
    };
    const redis = { client: { ttl: jest.fn(async () => -2) }, acquireLock: jest.fn(async () => true), releaseLock: jest.fn(async () => true) };
    const audit = { record: jest.fn(async () => undefined) };
    const entitlement = { assertAction: jest.fn(async () => undefined) };
    const service = new NumbersService(db as any, waxum as any, audit as any, redis as any, entitlement as any, {} as any, {} as any);
    return { service, row };
  };
  const unreachable = () => Object.assign(new Error('fetch failed'), {});

  it('moves a line without a session even when the source Waxum does not answer', async () => {
    const waxum = {
      releaseSession: jest.fn(async () => { throw unreachable(); }),
      adoptSession: jest.fn(async () => { throw Object.assign(new Error('Waxum 500'), { statusCode: 500 }); }),
      statusOn: jest.fn(),
    };
    const { service, row } = setup(waxum);

    const moved = await service.moveToWaxumNode('t1', null, 'n1', 'edge-1');

    expect(moved.waxum_node).toBe('edge-1');
    expect(row.waxum_node).toBe('edge-1');
    expect(waxum.statusOn).not.toHaveBeenCalled();
  });

  it('moves the line to the online PC before asking for the pairing code', async () => {
    const waxum: Record<string, jest.Mock> = {
      // A session that never logged in, so the pairing has to start over on the online PC.
      getStatus: jest.fn(async () => ({ status: 'disconnected', is_logged_in: false })),
      createSession: jest.fn(async () => ({ id: 's2' })),
      deleteSession: jest.fn(async () => ({})),
      pairCode: jest.fn(async () => ({ code: 'ABCD-EFGH', timeout_seconds: 60 })),
    };
    const { service, row } = setup(waxum);

    const result = await service.pairCode('t1', 'u1', 'n1', '552731890428');

    expect(result.code).toBe('ABCD-EFGH');
    expect(row.waxum_node).toBe('edge-1');
    expect((waxum.createSession.mock.calls[0] as unknown[])[1]).toBe('edge-1');
    // A line without camouflage sends no identity.
    expect(waxum.pairCode).toHaveBeenCalledWith('s2', '552731890428', undefined);
  });

  it('answers a clear 503 instead of a 500 when no PC is online', async () => {
    const waxum = { pairCode: jest.fn(), getStatus: jest.fn(async () => ({})) };
    const { service } = setup(waxum, null);

    const error = await service.pairCode('t1', 'u1', 'n1', '552731890428').catch((e) => e);

    expect(error.getStatus()).toBe(503);
    expect(error.message).toMatch(/PC desta linha está fora do ar/);
    expect(waxum.pairCode).not.toHaveBeenCalled();
  });

  it('answers a clear 503 when the Waxum does not answer the pairing', async () => {
    const waxum = { pairCode: jest.fn(async () => { throw unreachable(); }) };
    const { service, row } = setup(waxum);
    row.waxum_node = 'edge-1';

    const error = await service.pairCode('t1', 'u1', 'n1', '552731890428').catch((e) => e);

    expect(error.getStatus()).toBe(503);
  });
});
