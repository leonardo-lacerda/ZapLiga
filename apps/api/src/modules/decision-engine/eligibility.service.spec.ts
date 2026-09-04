import { evaluateLeadEligibility, eligibilityErrorMessage } from './eligibility.service';

const base = {
  lead: { id: 'lead-1', phone: '5511999990000', status: 'queued', attempts: 0, nextEligibleAt: '2026-09-04T12:00:00.000Z', doNotCall: false },
  maxAttempts: 3,
  folderActive: true,
  contactSuppressed: false,
  callback: null,
  activeCall: false,
  scheduleAllowed: true,
  campaignAllowed: true,
  now: new Date('2026-09-04T12:00:00.000Z'),
} as const;

describe('eligibility contract', () => {
  it('keeps automatic, preview and simulation decisions in parity', () => {
    const decisions = (['automatic', 'preview', 'simulation'] as const).map((mode) => evaluateLeadEligibility({ ...base, mode }));
    expect(decisions.map((item) => item.eligible)).toEqual([true, true, true]);
    expect(decisions.map((item) => item.blockedBy)).toEqual([[], [], []]);
  });

  it('blocks suppression, inactive folders, active calls and exhausted attempts', () => {
    const result = evaluateLeadEligibility({ ...base, mode: 'automatic', contactSuppressed: true, folderActive: false, activeCall: true, lead: { ...base.lead, attempts: 3 } });
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toEqual(expect.arrayContaining(['contact_suppressed', 'folder_inactive', 'active_call', 'attempt_budget_exhausted']));
  });

  it('returns a structured wait reason without allowing a future retry', () => {
    const result = evaluateLeadEligibility({ ...base, mode: 'preview', lead: { ...base.lead, nextEligibleAt: '2026-09-04T12:01:00.000Z' } });
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain('next_attempt_wait');
  });

  it('keeps callback ownership explicit and blocks callbacks assigned to another SDR', () => {
    const result = evaluateLeadEligibility({ ...base, mode: 'automatic', sdrConnected: true, callback: { status: 'due', assignedSdrId: 'sdr-2' } });
    expect(result.blockedBy).toContain('callback_owned_by_another_sdr');
    expect(eligibilityErrorMessage(result)).toContain('outro SDR');
  });

  it('preserves the explicit manual redial override while retaining safety barriers', () => {
    const allowed = evaluateLeadEligibility({ ...base, mode: 'manual', manualQueueOverride: true, lead: { ...base.lead, status: 'completed', attempts: 99, nextEligibleAt: '2099-01-01T00:00:00.000Z' } });
    expect(allowed.eligible).toBe(true);
    const blocked = evaluateLeadEligibility({ ...base, mode: 'manual', manualQueueOverride: true, contactSuppressed: true });
    expect(blocked.blockedBy).toContain('contact_suppressed');
  });

  it('protects lines, cooldown and self-call pairing without allowing manual override to bypass protection', () => {
    const line = { phone: '5511999990000', status: 'connected', flaggedUntil: null, lastCallEndedAt: '2026-09-04T12:00:30.000Z', cooldownSeconds: 60 };
    const automatic = evaluateLeadEligibility({ ...base, mode: 'automatic', line });
    const manual = evaluateLeadEligibility({ ...base, mode: 'manual', manualQueueOverride: true, line });
    expect(automatic.blockedBy).toEqual(expect.arrayContaining(['line_protected', 'line_cooldown', 'self_call']));
    expect(manual.blockedBy).toEqual(expect.arrayContaining(['line_protected', 'self_call']));
  });
});
