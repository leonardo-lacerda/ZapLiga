import { ConflictException } from '@nestjs/common';
import { ExperimentsService } from './experiments.service';

const definition = {
  name: 'Cadência de retomada',
  hypothesis: 'Uma cadência mais curta pode aumentar a taxa de atendimento sem elevar falhas.',
  campaignId: 'campaign-1',
  primaryMetric: 'answer_rate',
  trafficPercent: 80,
  variants: [
    { key: 'control', name: 'Controle', allocationPercent: 50, cadenceMinutes: 60, priority: 50 },
    { key: 'treatment', name: 'Cadência curta', allocationPercent: 50, cadenceMinutes: 30, priority: 50 },
  ],
  guardrails: [
    { metric: 'failure_rate', operator: 'max', threshold: .25 },
    { metric: 'opt_out_rate', operator: 'max', threshold: .1 },
    { metric: 'rapid_drop_rate', operator: 'max', threshold: .3 },
    { metric: 'line_failure_rate', operator: 'max', threshold: .35 },
  ],
} as any;

describe('experiments safety', () => {
  it('requires the full definition before a startable experiment can be created', () => {
    const service = Object.create(ExperimentsService.prototype) as any;
    expect(service.normalizeDefinition(definition).variants[0].config).toEqual({ cadenceMinutes: 60, priority: 50 });
    expect(() => service.normalizeDefinition({ ...definition, guardrails: definition.guardrails.slice(0, 3) })).toThrow();
  });

  it('keeps the same lead assignment stable when the request is repeated', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ assignment_hash: 'hash', assigned_at: '2026-09-04T12:00:00.000Z', variant_id: 'variant-1', variant_key: 'control', name: 'Controle', allocation_percent: 50, config: { cadenceMinutes: 60, priority: 50 }, status: 'running' }] }) };
    const service = new ExperimentsService(db as any, {} as any);
    const first = await service.assign('tenant-1', 'experiment-1', 'lead-1');
    const second = await service.assign('tenant-1', 'experiment-1', 'lead-1');
    expect(first).toEqual(second);
    expect(first).toEqual(expect.objectContaining({ eligible: true, stable: true, variant: expect.objectContaining({ key: 'control' }) }));
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('stops a running experiment when a guardrail crosses its threshold', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'experiment-1', status: 'running', started_at: '2026-09-01T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ rows: definition.guardrails })
      .mockResolvedValueOnce({ rows: [{ assigned: 20, calls: 20, failed: 8, rapid_drops: 0, opt_outs: 0, line_failure_rate: .4 }] }),
      transaction: jest.fn(async (callback: any) => callback(client)) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ExperimentsService(db as any, audit as any);

    const result = await service.evaluateGuardrails('tenant-1', 'experiment-1');

    expect(result.status).toBe('stopped');
    expect(result.triggered.map((item: any) => item.metric)).toEqual(['failure_rate', 'line_failure_rate']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("status='stopped'"), expect.any(Array));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'experiment.guardrail_triggered' }), client);
  });

  it('does not start an experiment in a terminal state', async () => {
    const service = Object.create(ExperimentsService.prototype) as any;
    expect(() => service.validateStartable({ status: 'stopped', hypothesis: 'x', primaryMetric: 'answer_rate', variants: [], guardrails: [] })).toThrow(ConflictException);
  });
});
