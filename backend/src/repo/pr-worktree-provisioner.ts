import { dirname, basename, join } from 'node:path';
import { ValidationError } from '../kernel/error-types.js';
import type { RepoProvider } from './repo-contract.js';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a `git` command (args already include any `-C <repo>`). */
export type GitWorktreeRunner = (args: string[]) => Promise<GitRunResult>;

export interface PrWorktreeProvisionerDeps {
  git: GitWorktreeRunner;
  /** Whether a directory already exists on disk. */
  pathExists: (path: string) => boolean;
}

export interface ProvisionPrWorktreeInput {
  /** The repository's primary local checkout (has `origin` configured). */
  repoLocalPath: string;
  provider: RepoProvider;
  /** Provider-native PR number/id. */
  number: number;
  /** Head branch name; used for Azure DevOps (GitHub uses the pull ref). */
  sourceBranch: string;
}

export interface ProvisionedWorktree {
  /** Absolute path of the checked-out worktree sessions run in. */
  worktreePath: string;
  /** Local branch the worktree tracks the PR head on. */
  branch: string;
}

/** Where a PR's worktree lives: a sibling `.ai-worktrees` dir next to the repo. */
export function prWorktreePath(repoLocalPath: string, number: number): string {
  return join(
    dirname(repoLocalPath),
    '.ai-worktrees',
    `${basename(repoLocalPath)}-pr-${number}`,
  );
}

/**
 * Checks a pull request out into a dedicated git worktree so it can be reviewed
 * in its own session without disturbing the repository's primary checkout (and
 * so multiple PR reviews can run concurrently). GitHub PRs are fetched via the
 * universal `pull/<n>/head` ref (works for fork branches); Azure DevOps PRs are
 * fetched by their source branch. Idempotent: an existing worktree is reused.
 */
export async function provisionPrWorktree(
  deps: PrWorktreeProvisionerDeps,
  input: ProvisionPrWorktreeInput,
): Promise<ProvisionedWorktree> {
  const worktreePath = prWorktreePath(input.repoLocalPath, input.number);
  const branch = `pr-${input.number}`;
  if (deps.pathExists(worktreePath)) {
    return { worktreePath, branch };
  }

  const sourceRef =
    input.provider === 'github'
      ? `pull/${input.number}/head`
      : input.sourceBranch;
  const fetch = await deps.git([
    '-C',
    input.repoLocalPath,
    'fetch',
    'origin',
    `${sourceRef}:${branch}`,
  ]);
  if (fetch.code !== 0) {
    throw new ValidationError(
      fetch.stderr.trim() || `Failed to fetch pull request #${input.number}`,
    );
  }

  const add = await deps.git([
    '-C',
    input.repoLocalPath,
    'worktree',
    'add',
    worktreePath,
    branch,
  ]);
  if (add.code !== 0) {
    throw new ValidationError(
      add.stderr.trim() || 'Failed to create the review worktree',
    );
  }
  return { worktreePath, branch };
}
