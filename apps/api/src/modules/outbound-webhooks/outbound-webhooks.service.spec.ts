import { encryptSecret } from '../lead-ingestion/lead-ingestion.crypto';
import { OutboundWebhooksService } from './outbound-webhooks.service';

describe('outbound webhooks', () => {
  it('creates a signed endpoint and never exposes its secret in list responses', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'hook-1', label: 'Analytics', url: 'https://example.test/hook', event_types: ['call.ended'], status: 'active' }] }) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new OutboundWebhooksService(db as any, audit as any);
    const created = await service.create('tenant-1', 'user-1', { label: 'Analytics', url: 'https://example.test/hook', eventTypes: ['call.ended'] });
    expect(created.secret).toMatch(/^zpl_wh_/);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'outbound_webhook.created' }));
    const listed = await service.list('tenant-1');
    expect(listed.items[0]).not.toHaveProperty('secret');
  });

  it('rejects insecure non-local destinations and unknown event types', async () => {
    const service = new OutboundWebhooksService({ query: jest.fn() } as any, { record: jest.fn() } as any);
    await expect(service.create('tenant-1', 'user-1', { label: 'Hook', url: 'http://example.test/hook' })).rejects.toThrow('HTTPS');
    await expect(service.create('tenant-1', 'user-1', { label: 'Hook', url: 'https://example.test/hook', eventTypes: ['unknown.event'] })).rejects.toThrow('não catalogados');
  });

  it('schedules a retry with typed parameters when a delivery fails', async () => {
    const pending = { id: 'delivery-1', tenant_id: 'tenant-1', endpoint_id: 'hook-1', event_id: 'event-1', event_type: 'call.ended', idempotency_key: 'k', payload: {}, attempts: 0 };
    const db = { query: jest.fn(async (sql: string) => {
      if (sql.includes("status='pending' AND next_attempt_at")) return { rows: [pending] };
      if (sql.startsWith('SELECT url, secret_ciphertext')) return { rows: [{ url: 'https://example.test/hook', secret_ciphertext: encryptSecret('zpl_wh_test') }] };
      return { rows: [] };
    }) };
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    const service = new OutboundWebhooksService(db as any, { record: jest.fn() } as any);
    try { await service.flush(); } finally { global.fetch = originalFetch; }
    const update = db.query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE outbound_webhook_deliveries SET status=CASE'));
    expect(String(update?.[0])).toContain('$2::int >= $3::int');
    expect(String(update?.[0])).toContain('attempts=$2::int');
  });
});
