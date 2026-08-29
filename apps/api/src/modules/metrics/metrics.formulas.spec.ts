import { answerRate, avgAttemptsPerLead, avgConnectedDurationSeconds, civilDateInTimezone, compareToPrevious, dayRangeInTimezone, daysBetweenDateStrs, lastCompleteDayInRange, numberUtilization, safeRate, sdrUtilization, shiftDateStr, timezoneOffsetMinutes, wrapUpRate } from './metrics.formulas';

describe('safeRate', () => {
  it('returns 0 when the denominator is zero, never NaN or null', () => {
    expect(safeRate(0, 0)).toBe(0);
    expect(safeRate(5, 0)).toBe(0);
  });

  it('rounds to one decimal place', () => {
    expect(safeRate(1, 3)).toBe(33.3);
    expect(safeRate(2, 3)).toBe(66.7);
    expect(safeRate(1, 2)).toBe(50);
  });
});

describe('answerRate / wrapUpRate / numberUtilization / sdrUtilization', () => {
  it('all delegate to the shared zero-denominator-safe percentage', () => {
    expect(answerRate(40, 100)).toBe(40);
    expect(answerRate(0, 0)).toBe(0);
    expect(wrapUpRate(9, 10)).toBe(90);
    expect(wrapUpRate(0, 0)).toBe(0);
    expect(numberUtilization(1, 2)).toBe(50);
    expect(sdrUtilization(1800, 3600)).toBe(50);
  });
});

describe('avgAttemptsPerLead', () => {
  it('is 0 when there are no unique leads worked, avoiding a division by zero', () => {
    expect(avgAttemptsPerLead(10, 0)).toBe(0);
  });

  it('divides attempts by unique leads', () => {
    expect(avgAttemptsPerLead(10, 4)).toBe(2.5);
  });
});

describe('avgConnectedDurationSeconds', () => {
  it('never mixes unanswered calls into the average (plan section 4, row "Duração média")', () => {
    expect(avgConnectedDurationSeconds(0, 0)).toBe(0);
  });

  it('divides connected time by answered calls only', () => {
    expect(avgConnectedDurationSeconds(600, 5)).toBe(120);
  });
});

describe('compareToPrevious', () => {
  it('reports no comparison as null, not as a misleading 0%/100% swing', () => {
    expect(compareToPrevious(50, null)).toEqual({ changeAbsolute: null, changePercent: null });
  });

  it('computes absolute and percent change against a real previous value', () => {
    expect(compareToPrevious(150, 100)).toEqual({ changeAbsolute: 50, changePercent: 50 });
    expect(compareToPrevious(50, 100)).toEqual({ changeAbsolute: -50, changePercent: -50 });
  });

  it('treats 0 -> 0 as no change, and 0 -> N as undefined percent (previous denominator is zero)', () => {
    expect(compareToPrevious(0, 0)).toEqual({ changeAbsolute: 0, changePercent: 0 });
    expect(compareToPrevious(10, 0)).toEqual({ changeAbsolute: 10, changePercent: null });
  });
});

describe('timezoneOffsetMinutes', () => {
  it('returns -180 for America/Sao_Paulo (fixed UTC-3 since Brazil dropped DST in 2019)', () => {
    expect(timezoneOffsetMinutes('America/Sao_Paulo', new Date('2026-01-15T12:00:00.000Z'))).toBe(-180);
    expect(timezoneOffsetMinutes('America/Sao_Paulo', new Date('2026-07-15T12:00:00.000Z'))).toBe(-180);
  });

  it('returns 0 for UTC', () => {
    expect(timezoneOffsetMinutes('UTC', new Date('2026-01-15T12:00:00.000Z'))).toBe(0);
  });
});

describe('dayRangeInTimezone', () => {
  it('converts a civil day in America/Sao_Paulo to its UTC instant boundaries', () => {
    const { startUtc, endUtc } = dayRangeInTimezone('2026-03-10', 'America/Sao_Paulo');
    expect(startUtc.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(endUtc.toISOString()).toBe('2026-03-11T02:59:59.999Z');
  });
});

describe('civilDateInTimezone', () => {
  it('resolves the calendar date on the far side of midnight UTC for a western timezone', () => {
    expect(civilDateInTimezone(new Date('2026-03-10T01:00:00.000Z'), 'America/Sao_Paulo')).toBe('2026-03-09');
    expect(civilDateInTimezone(new Date('2026-03-10T04:00:00.000Z'), 'America/Sao_Paulo')).toBe('2026-03-10');
  });
});

describe('shiftDateStr / daysBetweenDateStrs', () => {
  it('shifts by calendar days, including across a month boundary', () => {
    expect(shiftDateStr('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDateStr('2026-03-01', 6)).toBe('2026-03-07');
  });

  it('counts the days between two civil dates', () => {
    expect(daysBetweenDateStrs('2026-03-01', '2026-03-07')).toBe(6);
    expect(daysBetweenDateStrs('2026-03-01', '2026-03-01')).toBe(0);
  });
});

describe('lastCompleteDayInRange', () => {
  it('caps at yesterday when the range reaches today, so the current day never comes from a rollup (plan section 13, Fase 8)', () => {
    expect(lastCompleteDayInRange('2026-03-01', '2026-03-10', '2026-03-10')).toBe('2026-03-09');
  });

  it('uses the range end untouched when it is already entirely in the past', () => {
    expect(lastCompleteDayInRange('2026-03-01', '2026-03-05', '2026-03-10')).toBe('2026-03-05');
  });

  it('returns null when the whole range is today or later — nothing is complete yet', () => {
    expect(lastCompleteDayInRange('2026-03-10', '2026-03-10', '2026-03-10')).toBeNull();
    expect(lastCompleteDayInRange('2026-03-11', '2026-03-15', '2026-03-10')).toBeNull();
  });

  it('returns the single day itself when start equals the last complete day', () => {
    expect(lastCompleteDayInRange('2026-03-09', '2026-03-10', '2026-03-10')).toBe('2026-03-09');
  });
});
