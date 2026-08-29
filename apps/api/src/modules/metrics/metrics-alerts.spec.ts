import { buildAlerts, BuildAlertsInput } from './metrics-alerts';

function baseInput(overrides: Partial<BuildAlertsInput> = {}): BuildAlertsInput {
  return {
    current: { callsMade: 0, callsAnswered: 0, failedCalls: 0, uniqueLeadsWorked: 0 },
    previous: { callsMade: 0, callsAnswered: 0, failedCalls: 0, uniqueLeadsWorked: 0 },
    realtime: { activeCalls: 0, sdrsAvailable: 1, leadsReady: 0, numbersInQuarantine: 0, queueStalled: false },
    folders: [],
    numbers: [],
    openWrapUps: [],
    goalsBehind: [],
    ...overrides,
  };
}

describe('buildAlerts', () => {
  it('returns nothing for a quiet, healthy tenant', () => {
    expect(buildAlerts(baseInput())).toEqual([]);
  });

  it('flags a stalled queue as critical, and skips the milder no-SDR alert to avoid duplicating the same symptom', () => {
    const alerts = buildAlerts(baseInput({ realtime: { activeCalls: 0, sdrsAvailable: 0, leadsReady: 5, numbersInQuarantine: 0, queueStalled: true } }));
    expect(alerts.map((a) => a.code)).toEqual(['queue_stalled']);
    expect(alerts[0].severity).toBe('critical');
  });

  it('flags no SDR available when leads are ready but the queue is not fully stalled', () => {
    const alerts = buildAlerts(baseInput({ realtime: { activeCalls: 2, sdrsAvailable: 0, leadsReady: 5, numbersInQuarantine: 0, queueStalled: false } }));
    expect(alerts.map((a) => a.code)).toEqual(['no_sdr_available']);
  });

  it('flags numbers in quarantine', () => {
    const alerts = buildAlerts(baseInput({ realtime: { activeCalls: 0, sdrsAvailable: 1, leadsReady: 0, numbersInQuarantine: 2, queueStalled: false } }));
    expect(alerts.map((a) => a.code)).toEqual(['numbers_in_quarantine']);
  });

  it('ignores an answer-rate swing when the sample is too small to be meaningful', () => {
    const alerts = buildAlerts(baseInput({
      current: { callsMade: 3, callsAnswered: 0, failedCalls: 0, uniqueLeadsWorked: 3 },
      previous: { callsMade: 3, callsAnswered: 3, failedCalls: 0, uniqueLeadsWorked: 3 },
    }));
    expect(alerts).toEqual([]);
  });

  it('flags a real answer-rate drop once the sample is large enough', () => {
    const alerts = buildAlerts(baseInput({
      current: { callsMade: 100, callsAnswered: 20, failedCalls: 0, uniqueLeadsWorked: 90 },
      previous: { callsMade: 100, callsAnswered: 50, failedCalls: 0, uniqueLeadsWorked: 90 },
    }));
    expect(alerts.map((a) => a.code)).toContain('answer_rate_drop');
    expect(alerts.find((a) => a.code === 'answer_rate_drop')?.evidence).toContain('50%');
    expect(alerts.find((a) => a.code === 'answer_rate_drop')?.evidence).toContain('20%');
  });

  it('flags a real increase in technical failures', () => {
    const alerts = buildAlerts(baseInput({
      current: { callsMade: 100, callsAnswered: 50, failedCalls: 30, uniqueLeadsWorked: 90 },
      previous: { callsMade: 100, callsAnswered: 50, failedCalls: 5, uniqueLeadsWorked: 90 },
    }));
    expect(alerts.map((a) => a.code)).toContain('failure_rate_increase');
  });

  it('flags an abnormal attempts-per-lead ratio only above the minimum sample size', () => {
    const tooSmall = buildAlerts(baseInput({ current: { callsMade: 20, callsAnswered: 0, failedCalls: 0, uniqueLeadsWorked: 4 } }));
    expect(tooSmall).toEqual([]);

    const flagged = buildAlerts(baseInput({ current: { callsMade: 50, callsAnswered: 0, failedCalls: 0, uniqueLeadsWorked: 10 } }));
    expect(flagged.map((a) => a.code)).toContain('attempts_per_lead_anomaly');
  });

  it('flags concentration of failures in a single number, not spread evenly', () => {
    const evenlySpread = buildAlerts(baseInput({ numbers: [{ label: 'A', failed: 3 }, { label: 'B', failed: 3 }, { label: 'C', failed: 3 }] }));
    expect(evenlySpread.map((a) => a.code)).not.toContain('number_failure_concentration');

    const concentrated = buildAlerts(baseInput({ numbers: [{ label: 'A', failed: 8 }, { label: 'B', failed: 1 }] }));
    const alert = concentrated.find((a) => a.code === 'number_failure_concentration');
    expect(alert?.evidence).toContain('"A"');
  });

  it('flags active folders with an empty queue, naming up to 3 and summarizing the rest', () => {
    const folders = [
      { name: 'A', isActive: true, currentQueue: 0 },
      { name: 'B', isActive: true, currentQueue: 5 },
      { name: 'C', isActive: false, currentQueue: 0 },
      { name: 'D', isActive: true, currentQueue: 0 },
      { name: 'E', isActive: true, currentQueue: 0 },
      { name: 'F', isActive: true, currentQueue: 0 },
    ];
    const alerts = buildAlerts(baseInput({ folders }));
    const alert = alerts.find((a) => a.code === 'folder_without_eligible_leads');
    expect(alert?.evidence).toContain('4 pasta(s)');
    expect(alert?.evidence).toContain('e mais 1');
  });

  it('flags the longest-open pending wrap-up', () => {
    const alerts = buildAlerts(baseInput({ openWrapUps: [{ sdrName: 'Ana', minutesOpen: 25 }, { sdrName: 'Bruno', minutesOpen: 12 }] }));
    const alert = alerts.find((a) => a.code === 'pending_wrap_ups');
    expect(alert?.evidence).toContain('Ana');
    expect(alert?.evidence).toContain('25 min');
  });

  it('flags goals running behind pace, naming up to 3 and summarizing the rest', () => {
    const goalsBehind = [
      { label: 'Organização', metricLabel: 'Chamadas realizadas', progressPercent: 40 },
      { label: 'Ana', metricLabel: 'Leads trabalhados', progressPercent: 55 },
      { label: 'Bruno', metricLabel: 'Conversão', progressPercent: 10 },
      { label: 'Pasta A', metricLabel: 'Resultados positivos', progressPercent: 5 },
    ];
    const alerts = buildAlerts(baseInput({ goalsBehind }));
    const alert = alerts.find((a) => a.code === 'goals_behind');
    expect(alert?.evidence).toContain('4 meta(s)');
    expect(alert?.evidence).toContain('e mais 1');
    expect(alert?.evidence).toContain('Organização');
  });

  it('never phrases a recommendation as a confirmed cause', () => {
    const alerts = buildAlerts(baseInput({
      current: { callsMade: 100, callsAnswered: 20, failedCalls: 0, uniqueLeadsWorked: 90 },
      previous: { callsMade: 100, callsAnswered: 50, failedCalls: 0, uniqueLeadsWorked: 90 },
    }));
    for (const alert of alerts) {
      expect(alert.recommendedAction.toLowerCase()).not.toMatch(/\bcausad[oa] por\b|\bisso causou\b/);
    }
  });
});
