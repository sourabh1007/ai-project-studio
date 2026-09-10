import type { MetaPoolsStatus } from './types.js';

/**
 * How many AI turns the IDE should run in parallel so warm metasessions are
 * used efficiently instead of sitting idle.
 *
 * When the warm pool is enabled we fan out only across sessions that are idle
 * at the time of the snapshot. The configured target may still be warming or
 * blocked by process admission; using it would cold-spawn the difference and
 * recreate the process storm the warm pool is meant to prevent. When no warm
 * session is available we stay at 1 so the request can still take the bounded
 * cold path. The result is always at least 1.
 *
 * This is the shared rule for every fan-out of metasession work in the IDE
 * (review-board perspectives today, and any future parallel AI processing), so
 * available warm capacity is exploited rather than serialized.
 */
export function metaConcurrency(
  status: MetaPoolsStatus | null | undefined,
): number {
  if (!status || !status.enabled || !status.pool) {
    return 1;
  }
  return Math.max(1, status.pool.idle);
}