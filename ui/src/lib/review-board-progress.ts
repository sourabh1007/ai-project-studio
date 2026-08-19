/**
 * Pure helpers backing the Review Board's *progressive*, per-perspective AI
 * analysis. The page analyses each perspective independently and merges results
 * as they arrive; these functions keep the header roll-up in sync and bound how
 * many perspectives are analysed at once. Kept pure so the UI coverage gate can
 * exercise every branch without React.
 */

import type {
  ReviewBoard,
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
