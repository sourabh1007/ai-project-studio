/**
 * Pure helpers backing the Review Board's *progressive*, per-perspective AI
 * analysis. The page analyses each perspective independently and merges results
 * as they arrive; these functions keep the header roll-up in sync and bound how
 * many perspectives are analysed at once. Kept pure so the UI coverage gate can
 * exercise every branch without React.
 */

import type {
  ReviewBoard,
  ReviewBoardRatingChange,
  ReviewBoardSummary,
  ReviewPerspective,
  ReviewRecommendation,
} from './types.js';

/** Recompute the header roll-up counts from every perspective's findings. */
export function summarizePerspectives(
  perspectives: ReviewPerspective[],
): ReviewBoardSummary {
  let open = 0;
  let blocking = 0;
  let warnings = 0;
  let suggestions = 0;
  for (const p of perspectives) {
    for (const f of p.findings) {
      open += 1;
      if (f.severity === 'critical' || f.severity === 'high') blocking += 1;
      else if (f.severity === 'suggestion') suggestions += 1;
      else warnings += 1;
    }
  }
  return { open, blocking, warnings, suggestions };
}

/** The board recommendation for a summary; never auto-approves. */
export function recommendationFor(
  summary: ReviewBoardSummary,
): ReviewRecommendation {
  return summary.blocking > 0 ? 'request-changes' : 'needs-review';
}

/**
 * Replace one perspective in the board (by id) with its freshly analysed
 * version and recompute the summary + recommendation, so the header stays in
 * sync as perspectives complete one by one.
 */
export function mergeAnalyzedPerspective(
  board: ReviewBoard,
  perspective: ReviewPerspective,
): ReviewBoard {
  const perspectives = board.perspectives.map((p) =>
    p.id === perspective.id ? perspective : p,
  );
  const summary = summarizePerspectives(perspectives);
  return {
    ...board,
    perspectives,
    summary,
    recommendation: recommendationFor(summary),
  };
}

/**
 * Apply a review-agent rating change to the board: re-rate the target
 * perspective's status/risk (its findings are unchanged — the agent adjusts the
 * verdict, not the evidence list) and recompute the header roll-up. A change
 * naming a perspective that is not on the board is a no-op, so a stale proposal
 * can never corrupt the board.
 */
export function applyAgentRatingChange(
  board: ReviewBoard,
  change: ReviewBoardRatingChange,
): ReviewBoard {
  const target = board.perspectives.find((p) => p.id === change.perspectiveId);
  if (!target) return board;
  return mergeAnalyzedPerspective(board, {
    ...target,
    status: change.status,
    risk: change.risk,
  });
}

/** Options for {@link runWithRetry}. */
export interface RetryOptions {
  /** Total attempts before giving up (>= 1). */
  attempts: number;
  /** Sleeps `ms` between attempts; injected so tests stay fast. */
  delay: (ms: number) => Promise<void>;
  /** Backoff before the retry that follows a failed `attempt` (1-based). */
  backoffMs: (attempt: number) => number;
  /** Abandon the whole retry loop early (e.g. the run was cancelled). */
  cancelled?: () => boolean;
  /** Only retry when this returns true for the thrown error (default: always). */
  shouldRetry?: (error: unknown) => boolean;
  /** Notified before each backoff wait, with the attempt that just failed. */
  onRetry?: (nextAttempt: number, error: unknown) => void;
}

/** Sentinel thrown by {@link runWithRetry} when `cancelled()` becomes true. */
export class RetryCancelledError extends Error {
  constructor() {
    super('Retry cancelled.');
    this.name = 'RetryCancelledError';
  }
}

/**
 * Run `task(attempt)` with **self-healing retries**: on a retryable failure it
 * waits `backoffMs(attempt)` and tries again, up to `attempts` times, surfacing
 * the last error only once every attempt is exhausted. Honours `cancelled()`
 * both before starting and around the backoff so an aborted/reset run stops at
 * once instead of finishing its retries. `task` receives the 1-based attempt
 * number so callers can reflect "Retrying (n/N)…" in the UI.
 */
export async function runWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const total = Math.max(1, options.attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    if (options.cancelled?.()) throw new RetryCancelledError();
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < total &&
        !options.cancelled?.() &&
        (options.shouldRetry?.(error) ?? true);
      if (!canRetry) break;
      options.onRetry?.(attempt + 1, error);
      await options.delay(options.backoffMs(attempt));
      if (options.cancelled?.()) throw new RetryCancelledError();
    }
  }
  throw lastError;
}

/**
 * Run `task` over `items` with at most `limit` in flight at once, so several
 * perspectives analyse in parallel while the rest queue. Resolves once every
 * item is processed; individual failures must be handled inside `task`.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runNext = async (): Promise<void> => {
    if (queue.length === 0) return;
    const item = queue.shift() as T;
    await task(item);
    await runNext();
  };
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workers }, () => runNext()));
}

/** Default cadence for re-checking desired concurrency while work is queued. */
export const DYNAMIC_CONCURRENCY_POLL_MS = 2000;

/** Cancels a scheduled repeating poll. */
export type CancelPoll = () => void;

export interface DynamicConcurrencyOptions {
  /**
   * How often (ms) to re-read the desired limit while items are still queued,
   * so freshly added capacity is picked up mid-run.
   */
  readonly pollMs?: number;
  /** When true, stop dispatching new items; in-flight tasks still settle. */
  readonly cancelled?: () => boolean;
  /** Injectable repeating timer (tests); defaults to `setInterval`. */
  readonly schedule?: (fn: () => void, ms: number) => CancelPoll;
}

const defaultSchedule = (fn: () => void, ms: number): CancelPoll => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

/**
 * Like {@link mapWithConcurrency}, but the in-flight limit is re-evaluated while
 * work remains queued, so **capacity added mid-run is picked up dynamically**.
 *
 * When more metasessions come online (e.g. the warm pool grows or finishes
 * warming), queued perspectives should start immediately rather than waiting for
 * the run to restart. Workers are never pre-empted (an AI turn can't be
 * interrupted safely), but whenever the target limit rises and items are still
 * waiting, extra workers are spun up to drain the queue across the new capacity.
 * A shrinking limit simply stops new workers from being added; existing ones
 * finish their current item and wind down as the queue empties.
 *
 * `limit` may be a constant or a (possibly async) getter re-read on each poll;
 * a throwing/rejecting getter is treated as "no change this cycle". Resolves
 * once every item has been processed (or `cancelled()` turns true and all
 * in-flight tasks settle). Individual failures must be handled inside `task`.
 */
export async function mapWithDynamicConcurrency<T>(
  items: readonly T[],
  limit: number | (() => number | Promise<number>),
  task: (item: T) => Promise<void>,
  options: DynamicConcurrencyOptions = {},
): Promise<void> {
  const queue = [...items];
  const getLimit = typeof limit === 'function' ? limit : (): number => limit;
  const cancelled = options.cancelled ?? ((): boolean => false);
  let active = 0;
  let finished = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const maybeFinish = (): void => {
    if (!finished && active === 0 && (queue.length === 0 || cancelled())) {
      finished = true;
      settle();
    }
  };

  const spawnWorker = (): void => {
    active += 1;
    void (async () => {
      try {
        while (!cancelled() && queue.length > 0) {
          const item = queue.shift() as T;
          await task(item);
        }
      } finally {
        active -= 1;
        maybeFinish();
      }
    })();
  };

  const topUp = async (): Promise<void> => {
    if (finished) return;
    if (cancelled()) {
      maybeFinish();
      return;
    }
    let want: number;
    try {
      want = Math.max(1, Math.floor(await getLimit()));
    } catch {
      want = Math.max(1, active);
    }
    const room = Math.min(want - active, queue.length);
    for (let i = 0; i < room; i += 1) {
      spawnWorker();
    }
    maybeFinish();
  };

  await topUp();
  if (finished) return;
  const schedule = options.schedule ?? defaultSchedule;
  // Guard against overlapping polls: a starved `getLimit()` (the pool poll
  // competes for the same browser sockets as the fan-out turns) can take longer
  // than one interval. Without this guard every tick would launch another poll,
  // piling up requests that consume the very sockets needed and deepen the
  // starvation. Skip a tick while the previous poll is still in flight.
  let polling = false;
  const cancelPoll = schedule(() => {
    if (polling) return;
    polling = true;
    void topUp().finally(() => {
      polling = false;
    });
  }, options.pollMs ?? DYNAMIC_CONCURRENCY_POLL_MS);
  try {
    await done;
  } finally {
    cancelPoll();
  }
}
