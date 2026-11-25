import { afterEach, expect, it, vi } from 'vitest';
import { calendarUsageWindow } from './usage-window.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['day', '2026-11-02T23:59:59Z', '2026-11-02', '2026-11-03'],
  ['week', '2027-01-03T12:00:00Z', '2026-12-28', '2027-01-04'],
  ['month', '2024-02-29T12:00:00Z', '2024-02-01', '2024-03-01'],
  ['year', '2024-12-31T12:00:00Z', '2024-01-01', '2025-01-01'],
] as const)('uses UTC calendar boundaries for %s, including leap years and ISO-week rollover', (period, now, from, to) => {
  expect(calendarUsageWindow(period, new Date(now))).toEqual({ from, to });
});

it('uses the current date when no clock value is supplied', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-31T23:59:59Z'));
  expect(calendarUsageWindow('day')).toEqual({ from: '2026-12-31', to: '2027-01-01' });
});
