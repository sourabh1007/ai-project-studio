import type { Clock } from '../kernel/clock.js';
import type { PrReviewRepo, PrReviewStepBase } from './pr-review-contract.js';

/**
 * Message stamped on a review step that was left mid-generation when the app
 * exited. The metasession that was producing it died with the process, so the
 * step can never complete on its own — the reconciler fails it so the review
 * page shows a Retry instead of an eternal "Analyzing…" spinner.
 */
export const INTERRUPTED_STEP_MESSAGE =
  'Interrupted by a restart before it finished. Retry to regenerate.';

/**
 * Reconciles PR review steps left non-terminal by a previous run. When the app
 * exits, any in-flight metasessions die but their step status stays `pending`
 * or `generating`, which the review page renders as a spinner that never
 * resolves. On startup we transition every such orphaned step to `failed` with
 * a clear message so the page offers a retry instead of hanging forever.
 */
export interface PrReviewReconciler {
  /** Reconciles orphaned reviews, returning how many were updated. */
  reconcileOrphans(): number;
}

export interface PrReviewReconcilerDeps {
  reviews: PrReviewRepo;
  clock: Clock;
}

/** A step is settled once it has reached a terminal (ready/failed) state. */
function isSettled(step: PrReviewStepBase): boolean {
  return step.status === 'ready' || step.status === 'failed';
}

/**
 * Fails an orphaned step in place, preserving its type-specific fields (content,
 * modules, files, …) so only the status and failure change.
 */
function failStep<T extends PrReviewStepBase>(step: T, failedAt: string): T {
  return {
    ...step,
    status: 'failed',
    failure: { message: INTERRUPTED_STEP_MESSAGE, failedAt },
  };
}

export function createPrReviewReconciler(
  deps: PrReviewReconcilerDeps,
): PrReviewReconciler {
  const { reviews, clock } = deps;
  return {
    reconcileOrphans() {
      const failedAt = clock.isoNow();
      let reconciled = 0;
      for (const review of reviews.listAll()) {
        const problemOrphaned = !isSettled(review.problemStatement);
        const graphOrphaned = !isSettled(review.changeGraph);
        if (!problemOrphaned && !graphOrphaned) {
          continue;
        }
        reviews.save({
          ...review,
          problemStatement: problemOrphaned
            ? failStep(review.problemStatement, failedAt)
            : review.problemStatement,
          changeGraph: graphOrphaned
            ? failStep(review.changeGraph, failedAt)
            : review.changeGraph,
          timestamps: { ...review.timestamps, updatedAt: failedAt },
        });
        reconciled += 1;
      }
      return reconciled;
    },
  };
}
