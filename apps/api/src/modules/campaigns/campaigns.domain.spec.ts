import { diffCampaignSnapshots, hashCampaignSnapshot, resolveEffectiveCampaignConfig, validateCampaignDefinition } from './campaigns.domain';

const validDefinition = () => ({
  name: 'Prospecção enterprise',
  description: 'Campanha de teste',
  folderId: 'folder-1',
  primaryGoalMetric: 'qualified',
  primaryGoalTarget: 20,
  sdrIds: ['sdr-1'],
  numberIds: ['number-1'],
  config: {
    queueStrategy: 'priority_fifo' as const,
    maxAttemptsPerLead: 3,
    retryDelayMinutes: 30,
    maxCallsPerMinute: 6,
    minSecondsBetweenCalls: 10,
    timezone: 'America/Sao_Paulo',
    scheduleWindows: [{ dayOfWeek: 1, startTime: '09:00', endTime: '18:00' }],
    resultIds: ['interested'],
  },
});

describe('campaign domain', () => {
  it('validates a publishable campaign and returns machine-readable issues', () => {
    expect(validateCampaignDefinition(validDefinition(), true)).toEqual([]);
    const invalid = validDefinition();
    invalid.sdrIds = [];
    invalid.numberIds = [];
    invalid.config.scheduleWindows = [{ dayOfWeek: 8, startTime: '18:00', endTime: '09:00' }];
    expect(validateCampaignDefinition(invalid, true).map((issue) => issue.code)).toEqual([
      'campaign_team_required',
      'campaign_number_required',
      'campaign_schedule_window_invalid',
    ]);
  });

  it('never lets a campaign exceed global safety caps', () => {
    const effective = resolveEffectiveCampaignConfig({
      maxAttemptsPerLead: 3,
      retryDelayMinutes: 30,
      maxCallsPerMinute: 8,
      minSecondsBetweenCalls: 10,
      queueStrategy: 'fifo',
    }, {
      maxAttemptsPerLead: 10,
      maxCallsPerMinute: 20,
      minSecondsBetweenCalls: 2,
      queueStrategy: 'lifo',
    });
    expect(effective.maxAttemptsPerLead).toEqual({ value: 3, origin: 'safety_cap' });
    expect(effective.maxCallsPerMinute).toEqual({ value: 8, origin: 'safety_cap' });
    expect(effective.minSecondsBetweenCalls).toEqual({ value: 10, origin: 'safety_cap' });
    expect(effective.queueStrategy).toEqual({ value: 'lifo', origin: 'campaign_override' });
  });

  it('creates stable hashes and a field-level diff', () => {
    const first = { rules: { retry: 30, attempts: 2 }, sdr_ids: ['sdr-1'] };
    const reordered = { sdr_ids: ['sdr-1'], rules: { attempts: 2, retry: 30 } };
    expect(hashCampaignSnapshot(first)).toBe(hashCampaignSnapshot(reordered));
    expect(diffCampaignSnapshots(first, { ...reordered, rules: { attempts: 3, retry: 30 } })).toEqual([
      { path: 'rules.attempts', before: 2, after: 3 },
    ]);
  });
});
