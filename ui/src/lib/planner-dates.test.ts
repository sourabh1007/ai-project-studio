import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayDiff,
  formatDayLabel,
  isIsoDate,
  todayIso,
} from './planner-dates';

describe('todayIso', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('isIsoDate', () => {
  it('accepts a valid calendar day', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isIsoDate('2026-2-8')).toBe(false);
    expect(isIsoDate('nope')).toBe(false);
  });

  it('rejects impossible days', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});

describe('addDays', () => {
  it('moves forward and backward across month boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-02-10', 0)).toBe('2026-02-10');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
  });
});

describe('dayDiff', () => {
  it('counts whole days between dates', () => {
    expect(dayDiff('2026-02-10', '2026-02-10')).toBe(0);
    expect(dayDiff('2026-02-11', '2026-02-10')).toBe(1);
    expect(dayDiff('2026-02-09', '2026-02-10')).toBe(-1);
  });
});

describe('formatDayLabel', () => {
  const now = new Date(2026, 1, 10);

  it('labels relative days', () => {
    expect(formatDayLabel('2026-02-10', now)).toBe('Today');
    expect(formatDayLabel('2026-02-09', now)).toBe('Yesterday');
    expect(formatDayLabel('2026-02-11', now)).toBe('Tomorrow');
  });

  it('formats a distant day with weekday and year', () => {
    const label = formatDayLabel('2026-01-05', now);
    expect(label).toContain('2026');
    expect(label).toContain('Jan');
  });
});
