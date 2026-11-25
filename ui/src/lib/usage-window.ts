import type { UsageGranularity } from './types.js';

export interface UsageWindow {
  from: string;
  to: string;
}

export function calendarUsageWindow(period: UsageGranularity, now = new Date()): UsageWindow {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') from.setUTCDate(from.getUTCDate() - (from.getUTCDay() + 6) % 7);
  if (period === 'month') from.setUTCDate(1);
  if (period === 'year') from.setUTCMonth(0, 1);
  const to = new Date(from);
  if (period === 'year') to.setUTCFullYear(to.getUTCFullYear() + 1);
  else if (period === 'month') to.setUTCMonth(to.getUTCMonth() + 1);
  else to.setUTCDate(to.getUTCDate() + (period === 'week' ? 7 : 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
