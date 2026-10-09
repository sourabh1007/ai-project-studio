/**
 * Pure calendar-day helpers for the Planner's one-day-at-a-time navigation.
 * Days are `YYYY-MM-DD` strings in the user's local time zone; arithmetic is
 * done at UTC noon so daylight-saving shifts never move a day across midnight.
 */

/** Pads a number to two digits. */
function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

/** Today as a `YYYY-MM-DD` string in the user's local time zone. */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether a string is a strict `YYYY-MM-DD` calendar day. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Returns the calendar day `delta` days after `iso` (negative moves back). */
export function addDays(iso: string, delta: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() + delta);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

/** Whole-day signed difference `a - b` (e.g. today vs. the viewed day). */
export function dayDiff(a: string, b: string): number {
  const toUtc = (iso: string): number => {
    const [year, month, day] = iso.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/**
 * A friendly label for a day relative to `now`: "Today", "Yesterday",
 * "Tomorrow", or a weekday-qualified date like "Mon, Jan 5, 2026".
 */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, todayIso(now));
  if (diff === 0) {
    return 'Today';
  }
  if (diff === -1) {
    return 'Yesterday';
  }
  if (diff === 1) {
    return 'Tomorrow';
  }
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
