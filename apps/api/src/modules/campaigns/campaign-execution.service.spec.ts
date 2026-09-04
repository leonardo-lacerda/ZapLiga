import { CampaignExecutionService } from './campaign-execution.service';

describe('CampaignExecutionService', () => {
  it('resolves a running campaign and applies global safety caps', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      id: 'campaign-a', status: 'running', current_version: 3,
      config_snapshot: { rules: { maxAttemptsPerLead: 20, maxCallsPerMinute: 30, minSecondsBetweenCalls: 2, queueStrategy: 'priority_fifo' } },
      sdr_ids: ['sdr-a'], number_ids: ['number-a'],
    }] }) };
    const service = new CampaignExecutionService(db as any);

    const result = await service.resolveForLead('tenant-a', { id: 'lead-a', folder_id: 'folder-a', campaign_id: 'campaign-a', campaign_version: 2 }, {
      sdrId: 'sdr-a', numberId: 'number-a', globalSettings: { max_attempts_per_lead: 3, max_calls_per_minute: 6, min_seconds_between_calls: 10, retry_delay_minutes: 30, queue_strategy: 'fifo' },
    });

    expect(result).toMatchObject({ allowed: true, campaignId: 'campaign-a', campaignVersion: 2, reason: 'campaign_running' });
    expect(result.effectiveConfig.maxAttemptsPerLead).toEqual({ value: 3, origin: 'safety_cap' });
    expect(result.effectiveConfig.maxCallsPerMinute).toEqual({ value: 6, origin: 'safety_cap' });
    expect(result.effectiveConfig.minSecondsBetweenCalls).toEqual({ value: 10, origin: 'safety_cap' });
  });

  it('refuses a bound lead when the campaign is paused or the resource is outside its pool', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{
      id: 'campaign-a', status: 'paused', current_version: 1,
      config_snapshot: { rules: {} }, sdr_ids: ['sdr-a'], number_ids: ['number-a'],
    }] }) };
    const service = new CampaignExecutionService(db as any);

    const paused = await service.resolveForLead('tenant-a', { id: 'lead-a', folder_id: 'folder-a', campaign_id: 'campaign-a', campaign_version: 1 }, { sdrId: 'sdr-a', numberId: 'number-a' });
    expect(paused).toMatchObject({ allowed: false, reason: 'campaign_not_running' });

    (db.query as jest.Mock).mockResolvedValueOnce({ rows: [{
      id: 'campaign-a', status: 'running', current_version: 1,
      config_snapshot: { rules: {} }, sdr_ids: ['sdr-a'], number_ids: ['number-a'],
    }] });
    const outsidePool = await service.resolveForLead('tenant-a', { id: 'lead-a', folder_id: 'folder-a', campaign_id: 'campaign-a', campaign_version: 1 }, { sdrId: 'sdr-b', numberId: 'number-a' });
    expect(outsidePool).toMatchObject({ allowed: false, reason: 'campaign_resource_not_allowed' });
  });

  it('falls back to legacy execution when no campaign owns the lead folder', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const service = new CampaignExecutionService(db as any);
    const result = await service.resolveForLead('tenant-a', { id: 'lead-a', folder_id: 'folder-a' });
    expect(result).toMatchObject({ allowed: true, reason: 'legacy_fallback', campaignId: null, campaignVersion: null });
  });

  it('evaluates campaign-local schedule windows', () => {
    const config = {
      maxAttemptsPerLead: { value: 2, origin: 'global_default' as const },
      retryDelayMinutes: { value: 30, origin: 'global_default' as const },
      maxCallsPerMinute: { value: 6, origin: 'global_default' as const },
      minSecondsBetweenCalls: { value: 10, origin: 'global_default' as const },
      queueStrategy: { value: 'fifo', origin: 'global_default' as const },
      scheduleWindows: [{ dayOfWeek: 1, startTime: '09:00', endTime: '18:00' }],
      timezone: 'America/Sao_Paulo',
    };
    expect(CampaignExecutionService.scheduleAllowed(config, new Date('2026-09-07T15:00:00.000Z'))).toBe(true);
    expect(CampaignExecutionService.scheduleAllowed(config, new Date('2026-09-07T23:00:00.000Z'))).toBe(false);
  });
});
