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
});
