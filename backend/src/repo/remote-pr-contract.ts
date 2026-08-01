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
  /** Head/source branch name (no `refs/heads/` prefix). */
  sourceBranch: string;
  /** Author's display name or login, when known. */
  author: string | null;
}
