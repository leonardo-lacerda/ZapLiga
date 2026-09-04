import { calculateOperationHealth, calculateNumberHealth, HEALTH_FORMULA_VERSION, OperationHealthSignals } from './health-formula';

const healthySignals = (): OperationHealthSignals => ({
  numbers: { total: 2, connected: 2, cooldown: 0, quarantined: 0, rateLimited: 0, rapidFailures: 0 },
  calls: { attempts: 20, failures: 1 },
  capacity: { total: 4, active: 1 },
  team: { total: 2, available: 2 },
  queue: { ready: 4, waiting: 3, dueCallbacks: 0, exhausted: 0 },
  compliance: { scheduleAllowed: true, suppressionBlocks: 0, policyBlocks: 0 },
});

describe('operation health formula', () => {
  it('is deterministic for the same snapshot and formula version', () => {
    const input = healthySignals();
    expect(calculateOperationHealth(input)).toEqual(calculateOperationHealth(input));
    expect(calculateOperationHealth(input).formulaVersion).toBe(HEALTH_FORMULA_VERSION);
  });

  it('exposes a verifiable reason for a degraded operation', () => {
    const result = calculateOperationHealth({
      ...healthySignals(),
      numbers: { ...healthySignals().numbers, connected: 0, quarantined: 2, rapidFailures: 2 },
      calls: { attempts: 20, failures: 15 },
      team: { total: 2, available: 0 },
      queue: { ready: 10, waiting: 0, dueCallbacks: 0, exhausted: 0 },
    });
    expect(['degraded', 'attention']).toContain(result.state);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['no_connected_number', 'high_failure_rate', 'rapid_failure_streak', 'no_available_sdr']));
  });

  it('does not compensate a compliance block with a high operational score', () => {
    const result = calculateOperationHealth({ ...healthySignals(), compliance: { scheduleAllowed: false, suppressionBlocks: 0, policyBlocks: 0 } });
    expect(result.state).toBe('blocked');
    expect(result.score).toBe(0);
    expect(result.hardBlocks).toContain('outside_schedule');
  });

  it('reports insufficient data before inventing a confidence score', () => {
    const result = calculateOperationHealth({ ...healthySignals(), numbers: { total: 0, connected: 0, cooldown: 0, quarantined: 0, rateLimited: 0, rapidFailures: 0 }, calls: { attempts: 0, failures: 0 }, queue: { ready: 0, waiting: 0, dueCallbacks: 0, exhausted: 0 } });
    expect(result.state).toBe('insufficient_data');
    expect(result.reasonCodes).toContain('insufficient_sample');
  });

  it('keeps a protected number out of the healthy state', () => {
    const result = calculateNumberHealth({ status: 'connected', calls: { attempts: 10, failures: 0, rateLimited: 0, rapidFailures: 0 }, protections: { cooldown: false, quarantine: true } });
    expect(result.reasonCodes).toContain('line_protected');
    expect(result.score).toBeLessThan(100);
  });
});
