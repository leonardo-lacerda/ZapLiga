import { computeFindings, confidenceFor, DayRow, FallRow, quantile, smoothedPer100 } from './line-learnings.rules';

const day = (number_id: string, overrides: Partial<DayRow> = {}): DayRow => ({
  number_id, day: '2026-11-27', age_days: 2, stealth: false, device_profile: false, business: false, config_estimated: false,
  waxum_node: 'edge-1', calls: 30, answered: 6, short_answered: 1, closed_1005: 6, lost: false, reconnects: 1, node_moves: 0, ...overrides,
});
const fall = (number_id: string, callsSincePairing: number, overrides: Partial<FallRow> = {}): FallRow => ({
  number_id, cause: 'device_removed', hour: 19,
  context: { callsSincePairing, callsToday: callsSincePairing, lastCalls: Array.from({ length: 10 }, (_, i) => ({ at: '', answered: i < 1, talkSeconds: 5, outcome: i < 6 ? 'waxum_closed:1005' : 'sdr_hangup' })) },
  ...overrides,
});
const empty = { canaries: [], signals: [], hours: [] };

describe('line learnings v1', () => {
  it('smooths rates and grades confidence by lines', () => {
    expect(smoothedPer100(0, 0)).toBe(50);
    expect(smoothedPer100(1, 98)).toBe(2);
    expect(confidenceFor(4)).toBe('insufficient_data');
    expect(confidenceFor(5)).toBe('directional');
    expect(confidenceFor(10)).toBe('reliable');
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('says with how many calls the lines fall and sets the attention point from the first quartile', () => {
    const falls = ['a', 'b', 'c', 'd', 'e'].map((id, i) => fall(id, 20 + i * 5));
    const { findings, thresholds } = computeFindings({ days: [], falls, ...empty });
    const calls = findings.find((f) => f.key === 'calls_until_fall')!;
    expect(calls.values).toMatchObject({ falls: 5, q1: 25, median: 30 });
    expect(calls.confidence).toBe('directional');
    expect(thresholds).toMatchObject({ attentionCalls: 25, attentionConfidence: 'directional' });
  });

  it('keeps alerts off while the sample is small', () => {
    const { thresholds } = computeFindings({ days: [], falls: [fall('a', 20), fall('b', 30)], ...empty });
    expect(thresholds.attentionConfidence).toBe('insufficient_data');
  });

  it('flags 1005 errors before a fall as a precursor when they beat everyone\'s rate', () => {
    const days = Array.from({ length: 6 }, (_, i) => day(`l${i}`, { closed_1005: 3 }));
    const falls = ['a', 'b', 'c', 'd', 'e'].map((id) => fall(id, 30));
    const { findings, thresholds } = computeFindings({ days, falls, ...empty });
    expect(findings.find((f) => f.key === 'precursors')!.values).toMatchObject({ fall1005: 60, base1005: 10 });
    expect(thresholds.closed1005Rate).toBe(60);
  });

  it('compares setups only on days recorded on the day', () => {
    const days = [
      ...Array.from({ length: 5 }, (_, i) => day(`p${i}`, { waxum_node: 'proxy-1', lost: i < 3 })),
      ...Array.from({ length: 5 }, (_, i) => day(`c${i}`, { waxum_node: 'edge-1', lost: i < 1 })),
      day('old', { waxum_node: 'proxy-1', config_estimated: true, lost: false, calls: 500 }),
    ];
    const exit = computeFindings({ days, falls: [], ...empty }).findings.find((f) => f.key === 'exit')!;
    expect(exit.groups![0]).toMatchObject({ label: 'linhas no proxy', lines: 5, calls: 150, falls: 3 });
    expect(exit.answer).toContain('linhas no proxy caíram');
    expect(exit.confidence).toBe('directional');
  });

  it('reads the canary by how the line was released', () => {
    const canaries = [
      ...Array.from({ length: 5 }, (_, i) => ({ number_id: `f${i}`, manual: false, fell_after: i === 0 })),
      ...Array.from({ length: 5 }, (_, i) => ({ number_id: `m${i}`, manual: true, fell_after: i < 3 })),
    ];
    const canary = computeFindings({ days: [], falls: [fall('x', 1)], canaries, signals: [], hours: [] }).findings.find((f) => f.key === 'canary')!;
    expect(canary.values).toMatchObject({ canaryPassed: 5, canaryFellAfter: 1, manualPassed: 5, manualFellAfter: 3, fellOnFirstCall: 1 });
    expect(canary.answer).toContain('20%');
    expect(canary.answer).toContain('60%');
  });
});
