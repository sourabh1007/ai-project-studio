import type { MetaPoolsStatus } from './types.js';

/** Routing purpose used by AI turns without a dedicated warm pool. */
export const GENERAL_PURPOSE = 'general';

/**
 * How many AI turns of a given routing purpose the IDE should run in parallel
 * so warm metasessions are used efficiently instead of sitting idle.
 *
 * When warm pools are enabled we fan out only across sessions that are idle at
 * the time of the snapshot. The configured target may still be warming or
 * blocked by process admission; using it would cold-spawn the difference and
 * recreate the process storm warm pools are meant to prevent. When no warm
 * session is available we stay at 1 so the request can still take the bounded
 * cold path. The result is always at least 1.
 *
 * This is the shared rule for every fan-out of metasession work in the IDE
 * (review-board perspectives today, and any future parallel AI processing), so
 * available warm capacity is exploited rather than serialized.
 */
export function metaConcurrency(
  status: MetaPoolsStatus | null | undefined,
  purpose: string = GENERAL_PURPOSE,
): number {
  if (!status || !status.enabled) {
    return 1;
  }
  const match =
    status.pools.find((pool) => pool.purpose === purpose) ??
    status.pools.find((pool) => pool.purpose === GENERAL_PURPOSE);
  if (!match) {
    return 1;
  }
  return Math.max(1, match.idle);
}
