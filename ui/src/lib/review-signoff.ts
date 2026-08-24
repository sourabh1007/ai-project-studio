/**
 * Pure logic for the Review Board's **human sign-off** workflow.
 *
 * The AI review board is derived on demand and carries the machine verdict for
 * each perspective. Layered on top of it is a separate, human decision: after a
 * reviewer is satisfied with (or has corrected, via the agent) a perspective's
 * rating, they mark that perspective **reviewed**. Once every perspective is
 * reviewed the whole PR can be marked reviewed.
 *
 * This module owns the pure state shape and its transitions plus the wording
 * that turns raw machine statuses into the reviewer-facing "Reviewing" /
 * "Approve" / "Needs attention" labels. The stateful IO shell (persistence,
 * subscriptions) lives in the run store; keeping the decisions here is the same
 * ports-and-adapters split the rest of the app uses, and lets the UI coverage
 * gate exercise every branch.
 */

import type { ReviewStatus } from './types.js';

/** Per-feature human sign-off: which perspectives are reviewed, and the PR. */
export interface SignoffState {
  /** perspectiveId → ISO timestamp the reviewer signed it off. */
  perspectives: Record<string, string>;
  /** ISO timestamp the whole PR was marked reviewed, or null. */
  prReviewedAt: string | null;
}

/** A fresh, empty sign-off with nothing reviewed yet. */
export function emptySignoff(): SignoffState {
  return { perspectives: {}, prReviewedAt: null };
}

/** Whether a specific perspective has been signed off by the reviewer. */
export function isPerspectiveReviewed(
  state: SignoffState,
  perspectiveId: string,
): boolean {
  return Boolean(state.perspectives[perspectiveId]);
}

/** How many of the given perspectives the reviewer has signed off. */
export function reviewedCount(
  state: SignoffState,
  perspectiveIds: readonly string[],
): number {
  return perspectiveIds.filter((id) => isPerspectiveReviewed(state, id)).length;
}

/**
 * Whether every perspective has been signed off. An empty board is *not*
 * "all reviewed" — there is nothing to approve, so the PR cannot be marked
 * reviewed until real perspectives exist and are each signed off.
 */
export function allPerspectivesReviewed(
  state: SignoffState,
  perspectiveIds: readonly string[],
): boolean {
  return (
    perspectiveIds.length > 0 &&
    perspectiveIds.every((id) => isPerspectiveReviewed(state, id))
  );
}

/**
 * Return a new state with a perspective's sign-off set or cleared. Setting a
 * sign-off never implies the PR is reviewed; clearing one always invalidates a
 * prior PR sign-off, because the PR can only be reviewed while every
 * perspective is.
 */
export function withPerspectiveReviewed(
  state: SignoffState,
  perspectiveId: string,
  reviewedAt: string | null,
): SignoffState {
  const perspectives = { ...state.perspectives };
  if (reviewedAt) {
    perspectives[perspectiveId] = reviewedAt;
    return { ...state, perspectives };
  }
  delete perspectives[perspectiveId];
  return { perspectives, prReviewedAt: null };
}

/**
 * Clear the sign-off for several perspectives at once (e.g. because a fresh AI
 * pass re-rated them, invalidating the human decision). Also clears any PR
 * sign-off, since a re-rated perspective is no longer reviewed.
 */
export function clearPerspectivesReviewed(
  state: SignoffState,
  perspectiveIds: readonly string[],
): SignoffState {
  if (perspectiveIds.length === 0) return state;
  const perspectives = { ...state.perspectives };
  let changed = false;
  for (const id of perspectiveIds) {
    if (id in perspectives) {
      delete perspectives[id];
      changed = true;
    }
  }
  if (!changed && state.prReviewedAt === null) return state;
  return { perspectives, prReviewedAt: null };
}

/**
 * Return a new state with the PR marked reviewed. Refuses (returns the state
 * unchanged) unless every perspective is already signed off, so the "PR
 * reviewed" state can never contradict the per-perspective ones.
 */
export function withPrReviewed(
  state: SignoffState,
  perspectiveIds: readonly string[],
  reviewedAt: string,
): SignoffState {
  if (!allPerspectivesReviewed(state, perspectiveIds)) return state;
  return { ...state, prReviewedAt: reviewedAt };
}

/** Return a new state with any PR-level sign-off cleared. */
export function withPrReviewCleared(state: SignoffState): SignoffState {
  if (state.prReviewedAt === null) return state;
  return { ...state, prReviewedAt: null };
}

/** Reviewer-facing verdict wording for a settled perspective status. */
export function perspectiveVerdictLabel(status: ReviewStatus): string {
  switch (status) {
    case 'approved':
      return 'Approve';
    case 'not-applicable':
      return 'Not applicable';
    case 'not-started':
      return 'Not started';
    default:
      return 'Needs attention';
  }
}

/**
 * The badge wording for a perspective, given whether the AI is mid-analysis.
 * While the reviewer is analysing it reads "Reviewing"; otherwise it collapses
 * the raw machine status into the reviewer-facing verdict.
 */
export function perspectiveBadgeLabel(
  isAnalyzing: boolean,
  status: ReviewStatus,
): string {
  return isAnalyzing ? 'Reviewing' : perspectiveVerdictLabel(status);
}

/**
 * Parse a persisted sign-off blob defensively. Anything malformed collapses to
 * an empty sign-off so a corrupt localStorage entry can never crash the board.
 */
export function parseSignoff(raw: unknown): SignoffState {
  if (!raw || typeof raw !== 'object') return emptySignoff();
  const obj = raw as { perspectives?: unknown; prReviewedAt?: unknown };
  const perspectives: Record<string, string> = {};
  if (obj.perspectives && typeof obj.perspectives === 'object') {
    for (const [key, value] of Object.entries(
      obj.perspectives as Record<string, unknown>,
    )) {
      if (typeof value === 'string' && value) perspectives[key] = value;
    }
  }
  const prReviewedAt =
    typeof obj.prReviewedAt === 'string' && obj.prReviewedAt
      ? obj.prReviewedAt
      : null;
  return { perspectives, prReviewedAt };
}
