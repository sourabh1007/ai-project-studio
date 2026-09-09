import type { LiveState } from './stream.js';

/**
 * A token that changes whenever anything that could alter a feature's usage
 * totals has been observed on the live stream.
 *
 * The dashboard fetches its usage snapshot over HTTP, but the events that make
 * that snapshot stale already arrive on the SSE stream the app holds open. So
 * rather than polling on a timer, the dashboard re-fetches when this token
 * changes: no traffic while a feature is idle, and a refresh within a frame of
 * a turn being recorded.
 *
 * The token is deliberately opaque. Callers must only compare it for equality;
 * its shape is not part of the contract.
 */
export function featureUsageRevision(
  live: LiveState,
  featureId: string,
): string {
  let usageCount = 0;
  let latestUsageAt = '';
  for (const usage of Object.values(live.usageByKey)) {
    if (usage.featureId !== featureId) continue;
    usageCount += 1;
    // `endedAt` moves forward as turns land, so it distinguishes a replaced
    // entry from a genuinely new one even when the count is unchanged.
    if (usage.endedAt > latestUsageAt) latestUsageAt = usage.endedAt;
  }

  // A session's totals are only final once it stops running, and the closing
  // turn's usage can be written before the session row flips. Folding session
  // status in means the last refresh is triggered after the run settles rather
  // than one event too early.
  const sessionMarks: string[] = [];
  for (const session of Object.values(live.sessions)) {
    if (session.featureId !== featureId) continue;
    sessionMarks.push(`${session.id}:${session.status}`);
  }
  // The live caches are bounded and evict, so iteration order is not stable.
  // Sorting keeps the token a function of content alone.
  sessionMarks.sort();

  return `${usageCount}|${latestUsageAt}|${sessionMarks.join(',')}`;
}
