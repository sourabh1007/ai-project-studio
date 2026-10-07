import type { Repository } from '../repo/repo-contract.js';
import type { PrReviewPull } from './pr-review-contract.js';

/**
 * Whether a review thread on the PR is still open (`active`) or has been marked
 * resolved. Both providers collapse their richer native status vocabularies
 * (Azure `active/fixed/closed/…`, GitHub `isResolved`) onto this two-state view
 * the review page toggles.
 */
export type PrCommentThreadStatus = 'active' | 'resolved';

/** A reaction emoji available on PR comments (GitHub's set; Azure maps the thumbs-up only). */
export type PrReactionContent =
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'LAUGH'
  | 'HOORAY'
  | 'CONFUSED'
  | 'HEART'
  | 'ROCKET'
  | 'EYES';

/** The full ordered set of reaction contents the UI offers. */
export const PR_REACTION_CONTENTS: readonly PrReactionContent[] = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
];

/** An aggregated reaction on a comment. */
export interface PrReaction {
  content: PrReactionContent;
  /** Number of users who reacted with this emoji. */
  count: number;
  /** Whether the signed-in viewer has reacted with this emoji. */
  viewerReacted: boolean;
}

/** A single comment within a review thread, as shown in the comments panel. */
export interface PrComment {
  /** Provider-native comment id (string form). */
  id: string;
  /** Author's display name or login; null when the provider omits it. */
  author: string | null;
  /** URL to the author's avatar image; null when the provider omits it. */
  authorAvatarUrl: string | null;
  body: string;
  /** ISO timestamp the comment was posted; null when unknown. */
  createdAt: string | null;
  /** Aggregated reactions on the comment, newest providers first. */
  reactions: PrReaction[];
}

/**
 * A review thread anchored to a file + line of the pull request. Threads with no
 * file anchor (PR-level discussion) carry `path: null` / `line: null` and are
 * still listed so the panel shows every conversation on the PR.
 */
export interface PrCommentThread {
  /** Provider-native thread id (string form); used to resolve/reopen it. */
  id: string;
  /** Repo-relative file the thread is anchored to; null for PR-level threads. */
  path: string | null;
  /** 1-based line on the new (right) side of the diff; null when not anchored. */
  line: number | null;
  status: PrCommentThreadStatus;
  comments: PrComment[];
}

/**
 * A new comment the reviewer posts from the file popup. When `path` and `line`
 * are supplied the comment anchors to that new/right-side line; when both are
 * omitted it is posted as a PR-level (unanchored) comment — the fallback used
 * when the captured diff has no precise right-side anchor for the finding.
 */
export interface AddPrCommentInput {
  /** Captured Review Board head; when supplied, fail closed on stale or uncaptured anchors. */
  expectedHeadSha?: string;
  /** Repo-relative path of the changed file the comment anchors to; omitted for a PR-level comment. */
  path?: string;
  /** 1-based line on the new (right) side of the diff; omitted for a PR-level comment. */
  line?: number;
  /** The comment text. */
  body: string;
}

/** A reaction toggle the reviewer makes on an existing comment. */
export interface ReactPrCommentInput {
  /** Provider-native thread id the comment lives in (needed by Azure). */
  threadId: string;
  /** Provider-native comment id to react to. */
  commentId: string;
  /** Which reaction to toggle. */
  content: PrReactionContent;
  /** True to add the reaction, false to remove it. */
  on: boolean;
}

/**
 * The provider-agnostic port the comments service talks to. One instance is
 * bound to a single pull request (repo + number) by the composition root, which
 * picks the GitHub or Azure DevOps implementation from the repo's provider.
 */
export interface PrCommentsGateway {
  /** Every review thread on the PR, newest-anchored first is not guaranteed. */
  list(): Promise<PrCommentThread[]>;
  /** Posts a new inline comment thread and returns the created thread. */
  add(input: AddPrCommentInput): Promise<PrCommentThread>;
  /** Resolves or reopens a thread on the PR and returns its updated state. */
  setStatus(
    threadId: string,
    status: PrCommentThreadStatus,
  ): Promise<PrCommentThread>;
  /** Adds or removes a reaction on a comment and returns the updated comment. */
  react(input: ReactPrCommentInput): Promise<PrComment>;
}

/**
 * Resolves the right {@link PrCommentsGateway} for a repository + pull request.
 * Implemented in the composition root where the provider logins live, so the
 * comments service stays pure and unit-tested.
 */
export interface PrCommentsGatewayResolver {
  resolve(repo: Repository, pull: PrReviewPull): PrCommentsGateway;
}

/**
 * Application service backing the PR review page's comments panel and inline
 * comment box. Resolves a review's repo + PR, dispatches to the provider
 * gateway, and posts/reads/updates live against the real pull request.
 */
export interface PrCommentsService {
  list(featureId: string): Promise<PrCommentThread[]>;
  add(featureId: string, input: AddPrCommentInput): Promise<PrCommentThread>;
  setStatus(
    featureId: string,
    threadId: string,
    status: PrCommentThreadStatus,
  ): Promise<PrCommentThread>;
  react(featureId: string, input: ReactPrCommentInput): Promise<PrComment>;
}
