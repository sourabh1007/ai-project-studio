import type { MetaPoolsStatus } from './types.js';

/**
 * Upper bound on how many metasession AI turns the IDE fans out at once,
 * independent of how much warm capacity is idle.
 *
 * Each fanned-out turn is a long-lived synchronous HTTP request that holds one
 * browser connection open for the whole AI turn (which can run for minutes).
 * Chromium caps HTTP/1.1 connections at 6 per origin, and the IDE permanently
 * holds one of those for the live usage-stream `EventSource`. If a fan-out were
 * allowed to consume the rest, every idempotent control-plane GET (the session
 * list, `/meta/pools`, Settings) would be unable to get a socket and would hit
 * the client GET timeout — the UI appears frozen until a turn finishes.
 *
 * Capping the fan-out below the connection limit reserves headroom (the SSE
 * stream plus at least one free slot for the UI's own GETs) so the rest of the
 * app stays responsive while a large parallel pass (e.g. the review board) runs.
 */
const BROWSER_ORIGIN_CONNECTION_LIMIT = 6;
/** Connections kept free for the UI: the live usage-stream SSE + one GET slot. */
const RESERVED_CONNECTIONS = 2;
export const MAX_PARALLEL_META_TURNS =
  BROWSER_ORIGIN_CONNECTION_LIMIT - RESERVED_CONNECTIONS;

/**
 * How many AI turns the IDE should run in parallel so warm metasessions are
 * used efficiently — while always keeping one session free for other IDE work.
 *
 * Allotment is dynamic on the live warm capacity (booted sessions = idle +
 * busy), not on the momentary idle count:
 *
 * - When more than one warm session exists, we fan out across all but one of
 *   them and **reserve the last session for other IDE work** (summaries, PR
 *   review, repo context, chat) so a large review-board pass can never starve
 *   the rest of the IDE. Perspectives beyond that width queue and dispatch as
 *   sessions free up.
 * - When exactly one warm session exists, we use it (concurrency 1) and let the
 *   remaining perspectives queue behind it — there is nothing to reserve.
 * - When no warm session is booted yet, we stay at 1 so the request can still
 *   take the bounded cold path.
 *
 * Basing the width on live capacity (rather than idle) makes the reservation
 * structural: the review board is capped at `live - 1` regardless of how many
 * sessions happen to be idle at the snapshot, so one session is always held
 * back for interactive work. The result is always at least 1, and never exceeds
 * {@link MAX_PARALLEL_META_TURNS} so the UI keeps browser connections free for
 * its own control-plane traffic.
 *
 * This is the shared rule for every fan-out of metasession work in the IDE
 * (review-board perspectives today, and any future parallel AI processing).
 */
export function metaConcurrency(
  status: MetaPoolsStatus | null | undefined,
): number {
  if (!status || !status.enabled || !status.pool) {
    return 1;
  }
  const live = status.pool.live;
  // Reserve one live session for other IDE work when more than one exists;
  // with a single (or no) booted session there is nothing to hold back.
  const forFanOut = live > 1 ? live - 1 : 1;
  return Math.min(MAX_PARALLEL_META_TURNS, Math.max(1, forFanOut));
}