import { analyticsCatalog, sanitizeAnalyticsPayload } from './analytics-events.catalog';

describe('analytics event contract', () => {
  it('publishes only cataloged, non-PII fields', () => {
    expect(sanitizeAnalyticsPayload('call.ended', {
      status: 'completed', outcome: 'interessado', reason: 'texto livre', phone: '5511999990000', notes: 'não exportar',
    })).toEqual({ status: 'completed', outcome: 'interessado' });
  });

  it('exposes a versioned catalog and rejects unknown events', () => {
    expect(analyticsCatalog().find((item) => item.eventType === 'health.changed')).toMatchObject({ schemaVersion: 1 });
    expect(() => sanitizeAnalyticsPayload('unknown.event', {})).toThrow('não catalogado');
  });
});
