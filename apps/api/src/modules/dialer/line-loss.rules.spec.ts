import { classifyLineLoss, dialBlockUntil, isRegistrationReason, lineLossEventId, lineLossPolicyEnabled, reachoutTimelockEnd } from './line-loss.rules';

const NOW = new Date('2026-11-27T12:00:00Z');

describe('classifyLineLoss', () => {
  it('reads the two losses the API always knew, from old and new Waxum images', () => {
    expect(classifyLineLoss('account_locked', {})?.cause).toBe('account_locked');
    expect(classifyLineLoss('logged_out', { data: { conflict: 'device_removed' } })?.cause).toBe('device_removed');
  });

  it('keeps the cause an account lock states (Waxum v10), never asking for the appeal token', () => {
    const lock = classifyLineLoss('account_locked', { data: { details: { reason: '403', violation_reason: 'other_harm', vt: '1', location: 'rva' } } });
    expect(lock).toMatchObject({ cause: 'account_locked', code: '403', violationReason: 'other_harm', violationType: '1' });
  });

  it('turns a temporary ban into a deadline', () => {
    const ban = classifyLineLoss('temp_banned', { data: { code: 101, expire_secs: 3600 } }, NOW);
    expect(ban).toMatchObject({ cause: 'temp_banned', code: '101' });
    expect(ban?.expiresAt?.toISOString()).toBe('2026-11-27T13:00:00.000Z');
    expect(classifyLineLoss('temp_banned', { data: { code: 102 } }, NOW)?.expiresAt).toBeNull();
  });

  it('tells a refused client and a server hiccup apart from a loss', () => {
    expect(classifyLineLoss('connect_failure', { data: { code: 405 } })?.cause).toBe('client_rejected');
    expect(classifyLineLoss('connect_failure', { data: { code: 503 } })?.cause).toBe('transient');
    expect(classifyLineLoss('connect_failure', { data: { code: 402 } })?.cause).toBe('temp_banned');
    expect(classifyLineLoss('connect_failure', { data: { code: 499 } })?.cause).toBe('unknown');
    expect(classifyLineLoss('connect_failure', { data: {} })).toBeNull();
  });

  it('reads the other logouts by their reason', () => {
    expect(classifyLineLoss('logged_out', { data: { reason: 'LoggedOut' } })?.cause).toBe('logged_out_other');
    expect(classifyLineLoss('logged_out', { data: { reason: 'ClientOutdated' } })?.cause).toBe('client_rejected');
    expect(classifyLineLoss('logged_out', { data: { conflict: 'replaced' } })?.cause).toBe('transient');
    expect(classifyLineLoss('logged_out', { data: {} })).toBeNull();
  });

  it('reads the call server nack 463 as a reachout timelock and ignores other acks', () => {
    expect(classifyLineLoss('call_ack', { data: { error: '463' } })).toMatchObject({ cause: 'reachout_timelock', code: '463' });
    expect(classifyLineLoss('call_ack', { data: { id: 'x' } })).toBeNull();
  });

  it('ignores the routine restart after pairing', () => {
    expect(classifyLineLoss('stream_error', { data: { code: '515' } })).toBeNull();
    expect(classifyLineLoss('stream_error', { data: { code: '503' } })?.cause).toBe('transient');
  });

  it('survives a malformed payload', () => {
    expect(classifyLineLoss('logged_out', null)).toBeNull();
    expect(classifyLineLoss('temp_banned', 'x')?.cause).toBe('temp_banned');
    expect(classifyLineLoss('something_else', {})).toBeNull();
  });
});

describe('lineLossEventId', () => {
  it('is the same on both API instances for one event', () => {
    const payload = { timestamp: 1764244800 };
    expect(lineLossEventId('s1', 'temp_banned', payload, '101')).toBe(lineLossEventId('s1', 'temp_banned', payload, '101'));
    expect(lineLossEventId('s1', 'temp_banned', payload, '101')).not.toBe(lineLossEventId('s1', 'call_ack', payload, '463'));
  });
});

describe('isRegistrationReason', () => {
  it('accepts only what the phone can show', () => {
    expect(isRegistrationReason('too_many_guesses')).toBe(true);
    expect(isRegistrationReason('other')).toBe(false);
    expect(isRegistrationReason(3)).toBe(false);
  });
});

describe('dialBlockUntil', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  it('waits for what the server stated, or a fallback', () => {
    const stated = new Date('2026-11-27T15:00:00Z');
    expect(dialBlockUntil('temp_banned', stated, now)).toEqual(stated);
    expect(dialBlockUntil('temp_banned', null, now)?.toISOString()).toBe('2026-11-28T12:00:00.000Z');
    expect(dialBlockUntil('reachout_timelock', stated, now)).toEqual(stated);
    expect(dialBlockUntil('reachout_timelock', null, now)?.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(dialBlockUntil('media_failure', null, now)?.toISOString()).toBe('2026-11-27T12:30:00.000Z');
  });

  it('ignores a stated end already past and holds nothing for the other causes', () => {
    expect(dialBlockUntil('temp_banned', new Date('2026-11-27T11:00:00Z'), now)?.toISOString()).toBe('2026-11-28T12:00:00.000Z');
    expect(dialBlockUntil('transient', null, now)).toBeNull();
    expect(dialBlockUntil('device_removed', null, now)).toBeNull();
  });
});

describe('reachoutTimelockEnd', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  it('reads the end in seconds, milliseconds or ISO when the timelock is active', () => {
    expect(reachoutTimelockEnd({ is_active: true, time_enforcement_ends: '1795788000' }, now)?.toISOString()).toBe('2026-11-27T14:00:00.000Z');
    expect(reachoutTimelockEnd({ is_active: true, time_enforcement_ends: 1795788000000 }, now)?.toISOString()).toBe('2026-11-27T14:00:00.000Z');
    expect(reachoutTimelockEnd({ is_active: true, time_enforcement_ends: '2026-11-27T14:00:00Z' }, now)?.toISOString()).toBe('2026-11-27T14:00:00.000Z');
  });

  it('is null when inactive, past, unreadable or missing', () => {
    expect(reachoutTimelockEnd({ is_active: false, time_enforcement_ends: '1795788000' }, now)).toBeNull();
    expect(reachoutTimelockEnd({ is_active: true, time_enforcement_ends: '1795773600' }, now)).toBeNull();
    expect(reachoutTimelockEnd({ is_active: true, time_enforcement_ends: 'soon' }, now)).toBeNull();
    expect(reachoutTimelockEnd(null, now)).toBeNull();
  });
});

describe('lineLossPolicyEnabled', () => {
  it('is off unless LINE_LOSS_POLICY=v2, optionally for some tenants only', () => {
    expect(lineLossPolicyEnabled('t1', {})).toBe(false);
    expect(lineLossPolicyEnabled('t1', { LINE_LOSS_POLICY: 'v2' })).toBe(true);
    expect(lineLossPolicyEnabled('t1', { LINE_LOSS_POLICY: 'v2', LINE_LOSS_POLICY_TENANTS: 't2, t3' })).toBe(false);
    expect(lineLossPolicyEnabled('t3', { LINE_LOSS_POLICY: 'v2', LINE_LOSS_POLICY_TENANTS: 't2, t3' })).toBe(true);
  });
});
