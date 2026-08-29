import { MetricsConsistencyService } from './metrics-consistency.service';

describe('MetricsConsistencyService', () => {
  const query = jest.fn();
  const service = new MetricsConsistencyService({ query } as any);

  beforeEach(() => query.mockReset());

  it('omits checks that found nothing, so a clean tenant reports no issues', async () => {
    query.mockResolvedValue({ rows: [{ count: 0 }] });

    const result = await service.check('tenant-1');

    expect(result).toEqual([]);
    for (const call of query.mock.calls) expect(call[1]).toEqual(['tenant-1']);
  });

  it('surfaces only the checks with a non-zero count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // wrap_up_without_connection
      .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // call_result_outside_catalog
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // call_pipeline_stage_outside_catalog
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // lead_pipeline_stage_outside_catalog
      .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // lead_stage_history_drift
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }); // negative_call_duration

    const result = await service.check('tenant-1');

    expect(result).toEqual([
      { code: 'call_result_outside_catalog', description: expect.any(String), count: 3 },
      { code: 'lead_stage_history_drift', description: expect.any(String), count: 1 },
    ]);
  });
});
