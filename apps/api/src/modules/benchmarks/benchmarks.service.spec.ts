import { ConflictException } from '@nestjs/common';
import { BENCHMARK_PURPOSES, BENCHMARK_TERMS_VERSION } from './benchmarks.dto';
import { BenchmarksService } from './benchmarks.service';

describe('private benchmarks safety', () => {
  const input = { termsVersion: BENCHMARK_TERMS_VERSION, purposes: [...BENCHMARK_PURPOSES] } as any;

  afterEach(() => {
    delete process.env.BENCHMARK_CONSENT_APPROVED;
  });

  it('keeps opt-in closed until the external legal release is approved', async () => {
    const service = new BenchmarksService({} as any, {} as any);
    await expect(service.optIn('tenant-1', 'user-1', input)).rejects.toBeInstanceOf(ConflictException);
  });

  it('records a revocation as a new auditable event', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const db = {
      transaction: jest.fn(async (callback: any) => callback(client)),
      query: jest.fn().mockResolvedValue({ rows: [{ decision: 'opt_out', terms_version: BENCHMARK_TERMS_VERSION, purposes: [...BENCHMARK_PURPOSES], reason: 'Solicitado pela empresa', created_at: '2026-09-04T12:00:00.000Z' }] }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new BenchmarksService(db as any, audit as any);

    const result = await service.revoke('tenant-1', 'user-1', 'Solicitado pela empresa');

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO benchmark_consent_events'), expect.arrayContaining(['tenant-1', 'opt_out', BENCHMARK_TERMS_VERSION]));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'benchmark.consent_revoked', tenantId: 'tenant-1' }), client);
    expect(result.status).toBe('opt_out');
  });

  it('does not expose a tenant identifier in a public cohort row', () => {
    const service = Object.create(BenchmarksService.prototype) as any;
    const result = service.publicCohort({ team_size_band: '1_5', volume_band: '20_99', tenant_count: 5, call_count: 120, answer_rate_p25: .2, answer_rate_median: .3, answer_rate_p75: .4, answer_rate_trimmed: .31, positive_rate_trimmed: .08 });
    expect(result).toEqual(expect.objectContaining({ cohortKey: '1_5:20_99', eligibleTenants: 5, calls: 120 }));
    expect(result).not.toHaveProperty('tenantId');
  });
});
