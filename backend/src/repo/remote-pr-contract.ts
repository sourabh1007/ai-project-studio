import type { RepoProvider } from './repo-contract.js';

/**
 * An open pull request on a workspace repository's provider (GitHub / Azure
 * DevOps). The user picks one to review; the IDE then checks its branch out
 * into a dedicated git worktree and creates a feature whose sessions run there.
 */
export interface RemotePullRequest {
  provider: RepoProvider;
  /** Provider-native PR identifier (GitHub PR number / Azure pullRequestId). */
  number: number;
  title: string;
  /** Web URL of the pull request. */
  url: string;
  /**
   * The PR's description/body as authored, or null when the provider reports
   * none. Populated on single-PR fetch (`getPull`); list fetches leave it
   * undefined to stay lean. The problem-statement metasession distils this.
   */
  body?: string | null;
  /** Head/source branch name (no `refs/heads/` prefix). */
  sourceBranch: string;
  /**
   * Target/base branch the PR merges into (no `refs/heads/` prefix), or null
   * when the provider did not report it. This is the branch the review diffs
   * against; it is preferred over the repository's default branch because a PR
   * may target a release/feature branch rather than the repo default.
   */
  targetBranch?: string | null;
  /** Author's display name or login, when known. */
  author: string | null;
  /** True when the authenticated IDE user opened this pull request. */
  isAuthor?: boolean;
  /** True when the authenticated IDE user is a requested reviewer. */
  isReviewer?: boolean;
}

/** Which subset of a repository's pull requests to list. */
export type PullFilter = 'mine' | 'assigned' | 'all';
