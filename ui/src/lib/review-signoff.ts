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

import type { ReviewBoard, ReviewStatus } from './types.js';

export interface SignoffIdentity {
  repoId: string;
  prNumber: number;
  prUrl: string;
  reviewedCommit: string;
  evidenceRevision: string;
}

export interface SignoffHistoryEntry {
  archivedAt: string;
  reason: 'identity-changed' | 'legacy-missing-identity';
  identity: SignoffIdentity | null;
  perspectives: Record<string, string>;
  prReviewedAt: string | null;
}

export interface SignoffNotice {
  at: string;
  reason: 'identity-changed' | 'legacy-missing-identity';
  previousIdentity: SignoffIdentity | null;
  currentIdentity: SignoffIdentity | null;
}

export type SignoffIdentityStatus =
  | 'unknown'
  | 'refreshing'
  | 'fresh'
  | 'missing';

/** Per-feature human sign-off: which perspectives are reviewed, and the PR. */
export interface SignoffState {
  /** perspectiveId → ISO timestamp the reviewer signed it off. */
  perspectives: Record<string, string>;
  /** ISO timestamp the whole PR was marked reviewed, or null. */
  prReviewedAt: string | null;
  /** Identity the current decisions were made against, when known. */
  identity: SignoffIdentity | null;
  /** Whether the current board identity is fresh enough to certify sign-off. */
  identityStatus: SignoffIdentityStatus;
  /** Why the current identity cannot be trusted yet, when applicable. */
  identityError: string | null;
  /** Prior sign-offs preserved when the reviewed identity changes. */
  history: SignoffHistoryEntry[];
  /** Durable notice about an invalidated or legacy sign-off. */
  notice: SignoffNotice | null;
}

/** A fresh, empty sign-off with nothing reviewed yet. */
export function emptySignoff(): SignoffState {
  return {
    perspectives: {},
    prReviewedAt: null,
    identity: null,
    identityStatus: 'unknown',
    identityError: null,
    history: [],
    notice: null,
  };
}

const MAX_SIGNOFF_HISTORY = 12;

function sameIdentity(
  left: SignoffIdentity | null,
  right: SignoffIdentity | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasCurrentApprovals(state: SignoffState): boolean {
  return (
    state.prReviewedAt !== null || Object.keys(state.perspectives).length > 0
  );
}

function appendHistory(
  history: readonly SignoffHistoryEntry[],
  entry: SignoffHistoryEntry,
): SignoffHistoryEntry[] {
  return [...history, entry].slice(-MAX_SIGNOFF_HISTORY);
}

function consumeNotice(state: SignoffState): SignoffState {
  return state.notice ? { ...state, notice: null } : state;
}

export function canCertifySignoff(state: SignoffState): boolean {
  return state.identity !== null && state.identityStatus === 'fresh';
}

export function signoffNoticeText(state: SignoffState): string | null {
  switch (state.identityStatus) {
    case 'refreshing':
      return 'Revalidating review sign-off against the latest reviewed commit. Approval is temporarily disabled.';
    case 'unknown':
      return state.identityError
        ? `Could not refresh the reviewed commit identity: ${state.identityError}. Approval is temporarily disabled until it succeeds.`
        : 'Could not refresh the reviewed commit identity. Approval is temporarily disabled until it succeeds.';
    case 'missing':
      return 'Review sign-off is unavailable because the current board does not expose a reviewed commit identity.';
    case 'fresh':
      break;
  }
  if (!state.notice) {
    return null;
  }
  switch (state.notice.reason) {
    case 'identity-changed':
      return 'Review sign-off was cleared because the reviewed commit or evidence changed. Previous decisions were preserved as history.';
    case 'legacy-missing-identity':
      return 'A previous review sign-off was saved before review identity existed and cannot certify this code. Please review again.';
  }
}

function archiveCurrentSignoff(
  state: SignoffState,
  reason: SignoffHistoryEntry['reason'],
  archivedAt: string,
): SignoffHistoryEntry | null {
  if (!hasCurrentApprovals(state)) {
    return null;
  }
  return {
    archivedAt,
    reason,
    identity: state.identity,
    perspectives: { ...state.perspectives },
    prReviewedAt: state.prReviewedAt,
  };
}

export function resolveSignoffIdentity(
  board: Pick<ReviewBoard, 'repoId' | 'pull' | 'reviewUpdatedAt'>,
): SignoffIdentity | null {
  const repoId = board.repoId.trim();
  const prNumber = board.pull.number;
  const prUrl = board.pull.url.trim();
  const reviewedCommit = board.pull.headSha?.trim() ?? '';
  const evidenceRevision = board.reviewUpdatedAt.trim();
  if (
    repoId.length === 0 ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    prUrl.length === 0 ||
    reviewedCommit.length === 0 ||
    evidenceRevision.length === 0
  ) {
    return null;
  }
  return {
    repoId,
    prNumber,
    prUrl,
    reviewedCommit,
    evidenceRevision,
  };
}

export function beginSignoffIdentityRefresh(
  state: SignoffState,
): SignoffState {
  if (state.identityStatus === 'refreshing') {
    return state;
  }
  return {
    ...state,
    identityStatus: 'refreshing',
    identityError: null,
  };
}

export function recordSignoffIdentityFailure(
  state: SignoffState,
  message: string,
): SignoffState {
  return {
    ...state,
    identityStatus: 'unknown',
    identityError: message,
  };
}

export function syncSignoffIdentity(
  state: SignoffState,
  identity: SignoffIdentity | null,
  at: string,
): SignoffState {
  if (identity === null) {
    return {
      ...state,
      identityStatus: 'missing',
      identityError: null,
    };
  }

  if (state.identity === null && !hasCurrentApprovals(state)) {
    return {
      ...state,
      identity,
      identityStatus: 'fresh',
      identityError: null,
    };
  }

  if (sameIdentity(state.identity, identity)) {
    return {
      ...state,
      identity,
      identityStatus: 'fresh',
      identityError: null,
    };
  }

  const archived = archiveCurrentSignoff(
    state,
    state.identity === null ? 'legacy-missing-identity' : 'identity-changed',
    at,
  );
  if (!archived) {
    return {
      ...state,
      identity,
      identityStatus: 'fresh',
      identityError: null,
    };
  }
  return {
    perspectives: {},
    prReviewedAt: null,
    identity,
    identityStatus: 'fresh',
    identityError: null,
    history: appendHistory(state.history, archived),
    notice: {
      at,
      reason:
        state.identity === null
          ? 'legacy-missing-identity'
          : 'identity-changed',
      previousIdentity: state.identity,
      currentIdentity: identity,
    },
  };
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
    return consumeNotice({ ...state, perspectives });
  }
  delete perspectives[perspectiveId];
  return consumeNotice({ ...state, perspectives, prReviewedAt: null });
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
  return { ...state, perspectives, prReviewedAt: null };
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
  return consumeNotice({ ...state, prReviewedAt: reviewedAt });
}

/** Return a new state with any PR-level sign-off cleared. */
export function withPrReviewCleared(state: SignoffState): SignoffState {
  if (state.prReviewedAt === null) return state;
  return consumeNotice({ ...state, prReviewedAt: null });
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
  const obj = raw as {
    perspectives?: unknown;
    prReviewedAt?: unknown;
    identity?: unknown;
    identityStatus?: unknown;
    identityError?: unknown;
    history?: unknown;
    notice?: unknown;
  };
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
  const identity = parseIdentity(obj.identity);
  const identityStatus = parseIdentityStatus(obj.identityStatus);
  const history = Array.isArray(obj.history)
    ? obj.history
        .map((entry) => parseHistoryEntry(entry))
        .filter((entry): entry is SignoffHistoryEntry => entry !== null)
    : [];
  const notice = parseNotice(obj.notice);
  return {
    perspectives,
    prReviewedAt,
    identity,
    identityStatus: identityStatus ?? 'unknown',
    identityError:
      typeof obj.identityError === 'string' && obj.identityError
        ? obj.identityError
        : null,
    history,
    notice,
  };
}

function parseIdentity(raw: unknown): SignoffIdentity | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  return typeof obj.repoId === 'string' &&
      typeof obj.prNumber === 'number' &&
      typeof obj.prUrl === 'string' &&
      typeof obj.reviewedCommit === 'string' &&
      typeof obj.evidenceRevision === 'string'
    ? {
        repoId: obj.repoId,
        prNumber: obj.prNumber,
        prUrl: obj.prUrl,
        reviewedCommit: obj.reviewedCommit,
        evidenceRevision: obj.evidenceRevision,
      }
    : null;
}

function parseIdentityStatus(raw: unknown): SignoffIdentityStatus | null {
  return raw === 'unknown' ||
    raw === 'refreshing' ||
    raw === 'fresh' ||
    raw === 'missing'
    ? raw
    : null;
}

function parseHistoryEntry(raw: unknown): SignoffHistoryEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const reason = obj.reason;
  if (
    reason !== 'identity-changed' &&
    reason !== 'legacy-missing-identity'
  ) {
    return null;
  }
  const parsed = parseSignoff({
    perspectives: obj.perspectives,
    prReviewedAt: obj.prReviewedAt,
  });
  if (typeof obj.archivedAt !== 'string' || !obj.archivedAt) {
    return null;
  }
  return {
    archivedAt: obj.archivedAt,
    reason,
    identity: parseIdentity(obj.identity),
    perspectives: parsed.perspectives,
    prReviewedAt: parsed.prReviewedAt,
  };
}

function parseNotice(raw: unknown): SignoffNotice | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const reason = obj.reason;
  if (
    (reason !== 'identity-changed' &&
      reason !== 'legacy-missing-identity') ||
    typeof obj.at !== 'string' ||
    !obj.at
  ) {
    return null;
  }
  return {
    at: obj.at,
    reason,
    previousIdentity: parseIdentity(obj.previousIdentity),
    currentIdentity: parseIdentity(obj.currentIdentity),
  };
}
