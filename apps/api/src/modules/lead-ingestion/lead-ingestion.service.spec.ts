import { LeadIngestionService } from './lead-ingestion.service';
import { hashCredential, safeEqual, webhookSignature } from './lead-ingestion.crypto';

describe('LeadIngestionService', () => {
  const integration = {
    id: 'integration-1', tenant_id: 'tenant-1', public_id: 'li_public', status: 'active',
    field_mapping: {}, default_priority: 4, default_folder_id: 'folder-1', duplicate_policy: 'update_existing',
    api_key_hash: hashCredential('api-key'), signing_secret_ciphertext: '',
  };

  const makeService = () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [integration] }),
      transaction: jest.fn(async (callback: any) => callback({ query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'event-1', status: 'received' }] })
        .mockResolvedValue({ rows: [] }) })),
    };
    const redis = { client: { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) } };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new LeadIngestionService(db as any, redis as any, audit as any);
    jest.spyOn(service as any, 'flushOutbox').mockResolvedValue(undefined);
    return { service, db, redis, audit };
  };

  it('normalizes canonical and mapped payloads without changing tenant context', () => {
    const { service } = makeService();
    expect(service.normalizePayload({ contact: { fullName: 'Ana Silva', mobile: '+55 (11) 99999-0000', id: 'crm-1' } }, {
      name: 'contact.fullName', phone: 'contact.mobile', external_id: 'contact.id',
    }, 3)).toEqual({
      name: 'Ana Silva', phone: '5511999990000', externalId: 'crm-1', priority: 3, metadata: {},
    });
  });

  it('accepts an authenticated event and persists an outbox item', async () => {
    const { service, db, audit } = makeService();
    const result = await service.accept('li_public', {
      headers: { 'x-zapliga-api-key': 'api-key', 'idempotency-key': 'request-1' },
      ip: '127.0.0.1', rawBody: Buffer.from('{"name":"Ana Silva","phone":"5511999990000"}'),
      body: { name: 'Ana Silva', phone: '5511999990000' },
    }, false);
    expect(result.accepted).toBe(1);
    expect(result.duplicate).toBe(0);
    expect(db.transaction).toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns an existing event for a repeated idempotency key', async () => {
    const { service, db } = makeService();
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 'event-old', status: 'accepted' }] }) };
    db.transaction.mockImplementationOnce(async (callback: any) => callback(client));
    const result = await service.accept('li_public', {
      headers: { 'x-zapliga-api-key': 'api-key', 'idempotency-key': 'request-1' }, ip: '127.0.0.1',
      rawBody: Buffer.from('{}'), body: { name: 'Ana Silva', phone: '5511999990000' },
    }, false);
    expect(result.accepted).toBe(0);
    expect(result.duplicate).toBe(1);
    expect(result.events[0]).toEqual({ event_id: 'event-old', status: 'accepted' });
  });

  it('rejects malformed phones before persisting an event', async () => {
    const { service, db } = makeService();
    await expect(service.accept('li_public', {
      headers: { 'x-zapliga-api-key': 'api-key' }, ip: '127.0.0.1', rawBody: Buffer.from('{}'),
      body: { name: 'Ana Silva', phone: '123' },
    }, false)).rejects.toThrow('telefone válido');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('uses constant-time credential helpers and signs the raw payload', () => {
    const raw = Buffer.from('{"name":"Ana"}');
    const signature = webhookSignature('secret', '1700000000', raw);
    expect(safeEqual(signature, webhookSignature('secret', '1700000000', raw))).toBe(true);
    expect(safeEqual(signature, webhookSignature('other', '1700000000', raw))).toBe(false);
  });

  it('returns an absolute webhook URL using the public application origin', () => {
    const originalOrigin = process.env.WEB_ORIGIN;
    const originalApiOrigin = process.env.PUBLIC_API_ORIGIN;
    process.env.WEB_ORIGIN = 'https://admin.zapliga.com.br';
    process.env.PUBLIC_API_ORIGIN = 'https://app.zapliga.com.br';
    try {
      const { service } = makeService();
      expect((service as any).createWebhookUrl('li_public')).toBe('https://app.zapliga.com.br/api/v1/lead-integrations/li_public/webhook');
    } finally {
      if (originalOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = originalOrigin;
      if (originalApiOrigin === undefined) delete process.env.PUBLIC_API_ORIGIN;
      else process.env.PUBLIC_API_ORIGIN = originalApiOrigin;
    }
  });
});
