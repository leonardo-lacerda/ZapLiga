import { AnalyticsEventsService } from './analytics-events.service';

describe('analytics events service', () => {
  it('writes the canonical event and transactional outbox through the provided executor', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const db = { transaction: jest.fn(async (callback: any) => callback(client)) };
    const service = new AnalyticsEventsService(db as any);
    const result = await service.record({
      tenantId: 'tenant-1', eventType: 'call.ended', aggregateType: 'call', aggregateId: 'call-1', idempotencyKey: 'call.ended:call-1',
      payload: { status: 'completed', outcome: 'interessado', phone: '5511999990000' },
    });
    expect(result).toEqual({ eventId: 'event-1', eventType: 'call.ended', schemaVersion: 1 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1][10]).toBe('{"status":"completed","outcome":"interessado"}');
  });

  it('keeps a repeated idempotency key on the original event', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-existing' }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const db = { transaction: jest.fn(async (callback: any) => callback(client)) };
    const service = new AnalyticsEventsService(db as any);
    const result = await service.record({ tenantId: 'tenant-1', eventType: 'lead.received', aggregateType: 'lead', aggregateId: 'lead-1', idempotencyKey: 'lead.received:event-1', payload: { status: 'accepted' } });
    expect(result.eventId).toBe('event-existing');
    expect(client.query.mock.calls[1][0]).toContain('SELECT id FROM analytics_events');
  });
});
