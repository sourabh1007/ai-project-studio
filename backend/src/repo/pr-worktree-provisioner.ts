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
  /** The commit SHA the worktree was checked out at (the PR head fetched). */
  headSha: string;
  /**
   * True when `branch` is the PR's own head branch, tracking its `origin`
   * remote, so commits pushed from a session update the pull request. False for
   * fork PRs (whose head branch is not on `origin`), where a detached `pr-<n>`
   * review branch is used instead.
   */
  tracksPullRequest: boolean;
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
 * Turns a raw git checkout failure into a user-facing message. On Windows the
 * most common failure is the legacy 260-character `MAX_PATH` limit ("Filename
 * too long"): even though we pass `core.longpaths=true`, the OS itself must have
 * long paths enabled for some deep repositories. We detect that case and explain
 * the concrete remedy instead of surfacing a wall of raw git output.
 */
export function describeWorktreeFailure(
  stderr: string,
  fallback: string,
): string {
  const text = stderr.trim();
  if (/filename too long|unable to create file/i.test(text)) {
    return (
      'This pull request contains file paths longer than Windows allows, so the ' +
      'review checkout could not be created. Enable long paths and try again: ' +
      'run `git config --system core.longpaths true`, and set the Windows ' +
      '"LongPathsEnabled" policy (Group Policy → Enable Win32 long paths, or the ' +
      'registry key HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\' +
      'LongPathsEnabled = 1), then restart and retry.'
    );
  }
  return text || fallback;
}

/**
 * Explains why a pull request's commits could not be fetched from `origin`. The
 * common Azure DevOps case in large repos is "couldn't find remote ref": neither
 * the source branch nor the PR's `refs/pull/<n>/merge` ref could be resolved,
 * which usually means the source branch has not been published/favourited on the
 * server (so its ref is not advertised) or the PR is closed. We surface concrete
 * guidance instead of the raw git error.
 */
export function describeFetchFailure(
  input: ProvisionPrWorktreeInput,
  stderr: string,
): string {
  const text = stderr.trim();
  if (input.provider === 'azure-devops' && /couldn't find remote ref/i.test(text)) {
    return (
      `Couldn't fetch pull request #${input.number}: its source branch ` +
      `"${input.sourceBranch}" isn't published on the server, so Azure DevOps ` +
      `won't serve it over git. Open the pull request (or the branch) in Azure ` +
      `DevOps and mark the branch as a favourite / publish it, then try the ` +
      `review again.`
    );
  }
  return text || `Failed to fetch pull request #${input.number}`;
}

/**
 * Parses the checkout path git names when a branch is already checked out in
 * another worktree — the "...used by worktree at '<path>'" tail of errors like
 * `fatal: cannot force update the branch 'X' used by worktree at 'Q:/src/repo'`.
 * Returns null when the error is something else.
 */
export function checkedOutWorktreePath(stderr: string): string | null {
  const match = /used by worktree at '([^']+)'/i.exec(stderr);
  return match ? match[1] : null;
}

/**
 * Checks a pull request out into a dedicated git worktree so it can be reviewed
 * in its own session without disturbing the repository's primary checkout (and
 * so multiple PR reviews can run concurrently). GitHub PRs are fetched via the
 * universal `pull/<n>/head` ref (works for fork branches).
 *
 * Azure DevOps PRs are fetched by their source branch first, then — if that ref
 * is not resolvable — by the PR's own server-maintained `refs/pull/<n>/merge`
 * ref. In very large repositories (e.g. CosmosDB) the git server does not always
 * advertise every `users/*` topic branch, so a plain `fetch origin <branch>`
 * fails with "couldn't find remote ref" even though the branch exists; the
 * `refs/pull/<n>/merge` ref is created and kept up to date by Azure DevOps for
 * every active PR and is always resolvable, so the review checkout succeeds
 * without the user having to manually favourite/publish the branch first.
 *
 * The PR head is always fetched fresh from `origin` into `FETCH_HEAD`, so a
 * review reflects the latest remote state even when the worktree already exists.
 *
 * The worktree is checked out on the PR's *own* head branch, tracking its
 * `origin` remote branch, so commits made in a review session `git push`
 * straight back onto the pull request. This requires the head branch to live on
 * `origin` (same-repo PRs); a fork PR's head branch is not on `origin`, so we
 * fall back to a detached `pr-<n>` review branch that still reflects the fetched
 * head for reviewing but is not pushable to the PR.
 *
 * `FETCH_HEAD` is per-worktree, so the ref written by the fetch (run in the main
 * checkout) is invisible to the PR worktree's own git dir — a `reset --hard
 * FETCH_HEAD` there fails with "ambiguous argument 'FETCH_HEAD'". We therefore
 * resolve `FETCH_HEAD` to a concrete commit SHA in the main checkout immediately
 * after fetching and use that SHA everywhere it is checked out.
 */
export async function provisionPrWorktree(
  deps: PrWorktreeProvisionerDeps,
  input: ProvisionPrWorktreeInput,
): Promise<ProvisionedWorktree> {
  const worktreePath = prWorktreePath(input.repoLocalPath, input.number);

  const candidateRefs =
    input.provider === 'github'
      ? [`pull/${input.number}/head`]
      : [input.sourceBranch, `refs/pull/${input.number}/merge`];

  let fetched = false;
  let lastFetch: GitRunResult = { code: 1, stdout: '', stderr: '' };
  for (const ref of candidateRefs) {
    lastFetch = await deps.git([
      '-C',
      input.repoLocalPath,
      'fetch',
      'origin',
      ref,
    ]);
    if (lastFetch.code === 0) {
      fetched = true;
      break;
    }
  }
  if (!fetched) {
    throw new ValidationError(describeFetchFailure(input, lastFetch.stderr));
  }

  const revParse = await deps.git([
    '-C',
    input.repoLocalPath,
    'rev-parse',
    'FETCH_HEAD',
  ]);
  if (revParse.code !== 0) {
    throw new ValidationError(
      revParse.stderr.trim() ||
        `Failed to resolve the fetched head for pull request #${input.number}`,
    );
  }
  const headSha = revParse.stdout.trim();

  // Populate the head branch's remote-tracking ref so we can put the worktree on
  // a like-named local branch that tracks it. When the branch is not on `origin`
  // (a fork PR, or an Azure branch reached only via the merge ref) this fetch
  // fails and we keep the detached `pr-<n>` review branch.
  const trackFetch = input.sourceBranch
    ? await deps.git([
        '-C',
        input.repoLocalPath,
        'fetch',
        'origin',
        `+${input.sourceBranch}:refs/remotes/origin/${input.sourceBranch}`,
      ])
    : { code: 1, stdout: '', stderr: '' };
  const tracksPullRequest = trackFetch.code === 0;
  const branch = tracksPullRequest ? input.sourceBranch : `pr-${input.number}`;

  // When the PR's head branch is already checked out in another worktree
  // (commonly the repo's own primary working tree), git refuses to reset it
  // ("used by worktree at '<path>'"). Rather than failing, review that checkout
  // in place — the user's existing working copy is exactly what they want to
  // review, so we adopt its path and current HEAD without disturbing it.
  const reviewInPlace = async (
    inUsePath: string,
  ): Promise<ProvisionedWorktree> => {
    const rev = await deps.git(['-C', inUsePath, 'rev-parse', 'HEAD']);
    return {
      worktreePath: inUsePath,
      branch,
      tracksPullRequest,
      headSha: rev.code === 0 ? rev.stdout.trim() : headSha,
    };
  };

  // `checkout.workers=0` turns on git's parallel checkout, spreading the
  // working-tree file writes across one worker thread per CPU instead of the
  // serial default (`checkout.workers=1`). For a large repository (e.g. CosmosDB)
  // materialising the worktree is the dominant cost, so this is what makes the
  // review checkout noticeably faster. Unknown to older git, the setting is
  // simply ignored, so it is safe to always pass.
  if (deps.pathExists(worktreePath)) {
    const checkout = await deps.git([
      '-c',
      'core.longpaths=true',
      '-c',
      'checkout.workers=0',
      '-C',
      worktreePath,
      'checkout',
      '-f',
      '-B',
      branch,
      headSha,
    ]);
    if (checkout.code !== 0) {
      const inUse = checkedOutWorktreePath(checkout.stderr);
      if (inUse) {
        return reviewInPlace(inUse);
      }
      throw new ValidationError(
        describeWorktreeFailure(
          checkout.stderr,
          'Failed to update the review worktree',
        ),
      );
    }
  } else {
    const add = await deps.git([
      '-c',
      'core.longpaths=true',
      '-c',
      'checkout.workers=0',
      '-C',
      input.repoLocalPath,
      'worktree',
      'add',
      '--force',
      '-B',
      branch,
      worktreePath,
      headSha,
    ]);
    if (add.code !== 0) {
      const inUse = checkedOutWorktreePath(add.stderr);
      if (inUse) {
        return reviewInPlace(inUse);
      }
      throw new ValidationError(
        describeWorktreeFailure(
          add.stderr,
          'Failed to create the review worktree',
        ),
      );
    }
  }

  if (tracksPullRequest) {
    // Best-effort: link the local branch to its remote so a bare `git push` from
    // a session updates the PR. A failure here still leaves a usable worktree.
    await deps.git([
      '-C',
      worktreePath,
      'branch',
      `--set-upstream-to=origin/${input.sourceBranch}`,
      branch,
    ]);
  }

  return { worktreePath, branch, tracksPullRequest, headSha };
}
