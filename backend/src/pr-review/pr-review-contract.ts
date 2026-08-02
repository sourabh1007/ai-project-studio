import type { RemotePullRequest } from '../repo/remote-pr-contract.js';

/** Lifecycle of an automated PR review artifact. */
export type PrReviewStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** Minimal pull-request identity captured with a review so it can be re-run. */
export interface PrReviewPull {
  number: number;
  title: string;
  url: string;
}

/** A retryable generation failure surfaced to the review panel. */
export interface PrReviewFailure {
  message: string;
  failedAt: string;
}

/** Transition timestamps for a review. */
export interface PrReviewTimestamps {
  createdAt: string;
  updatedAt: string;
  /** When the current `ready` content was produced; null until first success. */
  generatedAt: string | null;
}

/**
 * An AI-generated review of a pull request, keyed by the review feature it
 * belongs to. Produced by an internal session that loads the repository context
 * plus the PR diff and returns a plain-language summary and a "core analysis"
 * (the key changes, risks, and what a reviewer should focus on).
 */
export interface PrReview {
  /** The PR review feature this artifact belongs to. */
  featureId: string;
  repoId: string;
  pull: PrReviewPull;
  /** The PR's git worktree the review analyses and reruns against. */
  worktreePath: string;
  /** Base branch the diff is computed against; null when unknown. */
  baseBranch: string | null;
  status: PrReviewStatus;
  /** Plain-language description of what the PR does; null until ready. */
  summary: string | null;
  /** Reviewer-focused analysis of the core changes; null until ready. */
  coreAnalysis: string | null;
  /** Number of files the PR changes versus its base; null until ready. */
  changedFiles: number | null;
  timestamps: PrReviewTimestamps;
  failure: PrReviewFailure | null;
}

/** A bounded view of a pull request's changes versus its base branch. */
export interface PrDiff {
  /** The concrete base ref the diff was taken against, when resolved. */
  baseRef: string | null;
  /** Number of files changed. */
  changedFiles: number;
  /** `git diff --stat` style summary text. */
  stat: string;
  /** Unified diff text, already bounded by the collector. */
  patch: string;
  /** True when the patch was truncated to fit the character budget. */
  truncated: boolean;
}

/** Input identifying the PR worktree/base to diff. */
export interface PrDiffRequest {
  worktreePath: string;
  baseBranch: string | null;
}

/** Collects a bounded PR diff. Implemented by a thin git adapter. */
export interface PrDiffCollector {
  collect(request: PrDiffRequest): Promise<PrDiff>;
}

/** Read port for the last-known ready repository context text. */
export interface ReadyRepositoryContext {
  /** Ready context summary for a repository, or null when not ready. */
  readyContent(repoId: string): string | null;
}

/** Persistence port for PR reviews. */
export interface PrReviewRepo {
  get(featureId: string): PrReview | null;
  save(review: PrReview): void;
  delete(featureId: string): void;
}

/** Input to start a review when a PR review feature is created. */
export interface StartPrReviewInput {
  featureId: string;
  repoId: string;
  pull: RemotePullRequest;
  worktreePath: string;
  baseBranch: string | null;
}

/** Events published as a review progresses, forwarded to the UI over SSE. */
export type PrReviewEventMap = {
  'pr.review.updated': PrReview;
};
