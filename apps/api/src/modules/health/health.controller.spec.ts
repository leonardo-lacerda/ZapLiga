import { HealthController } from './health.controller';

describe('HealthController operational metrics', () => {
  const previous = process.env.METRICS_TOKEN;
  afterEach(() => { if (previous === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = previous; });

  it('requires a dedicated token and exposes only aggregate metrics', async () => {
    process.env.METRICS_TOKEN = 'metrics-secret';
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ total: 3 }] }) };
    const redis = { metricsSnapshot: jest.fn().mockResolvedValue({ counters: { emails_failed_total: 2 }, timings: { email_delivery: { count: 4, sumMs: 1200 } } }) };
    const controller = new HealthController(db as any, redis as any);

    await expect(controller.metrics('Bearer wrong')).rejects.toMatchObject({ status: 401 });
    const payload = await controller.metrics('Bearer metrics-secret');
    expect(payload).toContain('zapliga_emails_failed_total 2');
    expect(payload).toContain('zapliga_callbacks_overdue 3');
    expect(payload).not.toMatch(/@|token|phone/i);
  });
});
