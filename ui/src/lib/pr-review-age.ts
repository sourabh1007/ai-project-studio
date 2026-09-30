/**
 * Pure helpers for showing and ordering how long a pull request has been open
 * for review. The picker's Team tab uses these to render a compact "in review
 * for" badge per PR and to sort teammates' PRs by wait time. Kept free of React
 * and IO so they are fully unit-testable.
 */

/** How the Team tab orders pull requests by their time in review. */
export type ReviewAgeOrder = 'longest' | 'newest';

/**
 * Milliseconds a pull request has been open, measured from its `createdAt`
 * timestamp to `now`. Returns null when the timestamp is missing or
 * unparseable so callers can treat "unknown age" distinctly. Negative results
 * (clock skew / a future timestamp) are clamped to 0.
 */
export function reviewAgeMs(
  createdAt: string | null | undefined,
  now: number,
): number | null {
  if (!createdAt) {
    return null;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return null;
  }
  const diff = now - created;
  return diff < 0 ? 0 : diff;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A compact, human-readable time-in-review label such as `just now`, `5m`,
 * `3h`, `2d`, or `6w`. Returns null when the age is unknown.
 */
export function formatReviewAge(
  createdAt: string | null | undefined,
  now: number,
): string | null {
  const ms = reviewAgeMs(createdAt, now);
  if (ms === null) {
    return null;
  }
  if (ms < MINUTE) {
    return 'just now';
  }
  if (ms < HOUR) {
    return `${Math.floor(ms / MINUTE)}m`;
  }
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR)}h`;
  }
  if (ms < WEEK) {
    return `${Math.floor(ms / DAY)}d`;
  }
  return `${Math.floor(ms / WEEK)}w`;
}

/**
 * Comparator for two pull requests by their time in review. `longest` puts the
 * oldest (longest-waiting) PR first; `newest` puts the most recently opened PR
 * first. Pull requests with an unknown age always sort last, regardless of
 * order, so they never crowd out actionable review work.
 */
export function compareByReviewAge(
  aCreatedAt: string | null | undefined,
  bCreatedAt: string | null | undefined,
  order: ReviewAgeOrder,
  now: number,
): number {
  const a = reviewAgeMs(aCreatedAt, now);
  const b = reviewAgeMs(bCreatedAt, now);
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return order === 'longest' ? b - a : a - b;
}

/**
 * The oldest (earliest) `createdAt` among a group of pull requests, or null
 * when none carry a timestamp. Used to order team-member groups by their
 * longest-waiting pull request.
 */
export function oldestCreatedAt(
  pulls: ReadonlyArray<{ createdAt?: string | null }>,
): string | null {
  let oldest: string | null = null;
  let oldestMs = Infinity;
  for (const pull of pulls) {
    if (!pull.createdAt) {
      continue;
    }
    const parsed = Date.parse(pull.createdAt);
    if (Number.isNaN(parsed)) {
      continue;
    }
    if (parsed < oldestMs) {
      oldestMs = parsed;
      oldest = pull.createdAt;
    }
  }
  return oldest;
}
