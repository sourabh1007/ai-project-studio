import type { MetaPoolsStatus } from './types.js';

/** Routing purpose used by AI turns without a dedicated warm pool. */
export const GENERAL_PURPOSE = 'general';

/**
 * How many AI turns of a given routing purpose the IDE should run in parallel
 * so warm metasessions are used efficiently instead of sitting idle.
 *
 * When warm pools are enabled we fan out up to the serving pool's size — its
 * parallel warm capacity — matching turns to the sessions kept ready (falling
 * back to the shared `general` pool a turn actually routes to). When warm pools
 * are disabled we stay at 1, because parallelizing there would spawn a storm of
 * cold `copilot` CLI processes. The result is always at least 1.
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
  return Math.max(1, match.size);
}
