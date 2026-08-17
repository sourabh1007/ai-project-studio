import type { GitRunResult } from '../repo/pr-worktree-provisioner.js';

/** A managed PR worktree the application created, surfaced for cleanup. */
export interface ManagedWorktree {
  /** Absolute checkout path on disk. */
  path: string;
  /** Local branch the worktree is on, or null when detached. */
  branch: string | null;
  /** Id of the repository the worktree belongs to. */
  repoId: string;
  /** Display name of the owning repository. */
  repoName: string;
  /** The pull request the worktree reviews, when derivable from its name. */
  pullNumber: number | null;
}

/** Runs a `git` command inside a given working directory. */
export interface WorktreeGit {
  run(args: string[], cwd: string): Promise<GitRunResult>;
}

/**
 * Lists and removes the git worktrees the application provisioned for PR
 * reviews, so their disk space can be reclaimed without hand-running git.
 */
export interface WorktreeService {
  /** All app-managed worktrees across every known repository. */
  list(): Promise<ManagedWorktree[]>;
  /** Removes the worktree at `path` (force) and prunes its administrative refs. */
  remove(path: string): Promise<void>;
  /** Best-effort removal of the worktree tied to a feature's PR review. */
  removeForFeature(featureId: string): Promise<void>;
}
