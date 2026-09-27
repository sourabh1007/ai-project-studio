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
  /**
   * Optional, best-effort: publish/favourite the PR's source branch on the
   * server before fetching it. Large Azure DevOps repositories don't advertise
   * every `users/*` topic branch, so favouriting it first lets the primary
   * `fetch origin <branch>` resolve (yielding a pushable worktree) instead of
   * falling back to the detached `refs/pull/<n>/merge` ref. Bound per-repo in
   * `main.ts` for Azure DevOps only. It returns the outcome (never throws for a
   * server-side "can't favourite" — that resolves to `ok:false`) so the checkout
   * can surface *why* it failed if the subsequent fetch also fails.
   */
  favouriteBranch?: () => Promise<FavouriteBranchOutcome>;
}

/** The result of the best-effort favourite step, surfaced in status + errors. */
export interface FavouriteBranchOutcome {
  ok: boolean;
  message: string;
}

/** A coarse phase of the checkout, surfaced to the UI as live status text. */
export type ProvisionPhase = 'favouriting' | 'fetching' | 'preparing';

export interface ProvisionStatus {
  phase: ProvisionPhase;
  message: string;
}

/** Notified as the checkout advances so the UI can show real-time progress. */
export type ProvisionStatusListener = (status: ProvisionStatus) => void;

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
  favouriteNote?: string | null,
): string {
  const text = stderr.trim();
  if (input.provider === 'azure-devops' && /couldn't find remote ref/i.test(text)) {
    const base =
      `Couldn't fetch pull request #${input.number}: its source branch ` +
      `"${input.sourceBranch}" isn't published on the server, so Azure DevOps ` +
      `won't serve it over git.`;
    if (favouriteNote) {
      return (
        `${base} Auto-favourite result: ${favouriteNote}. If the branch still ` +
        `isn't served, open the pull request (or the branch) in Azure DevOps ` +
        `and favourite / publish it, then try the review again.`
      );
    }
    return (
      `${base} Open the pull request (or the branch) in Azure DevOps and mark ` +
      `the branch as a favourite / publish it, then try the review again.`
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
 * The PR head is always fetched fresh from `origin` into a PR-specific ref, so a
 * review reflects the latest remote state even when the worktree already exists.
 *
 * The worktree is checked out on the PR's *own* head branch, tracking its
 * `origin` remote branch, so commits made in a review session `git push`
 * straight back onto the pull request. This requires the head branch to live on
 * `origin` (same-repo PRs); a fork PR's head branch is not on `origin`, so we
 * fall back to a detached `pr-<n>` review branch that still reflects the fetched
 * head for reviewing but is not pushable to the PR.
 *
 * Parallel PR imports must not read or write the primary checkout's shared
 * `FETCH_HEAD`. Each fetch targets a PR-specific ref which is resolved to an
 * immutable SHA before checkout, so another PR's fetch cannot change its base.
 */
export async function provisionPrWorktree(
  deps: PrWorktreeProvisionerDeps,
  input: ProvisionPrWorktreeInput,
  onStatus?: ProvisionStatusListener,
): Promise<ProvisionedWorktree> {
  const worktreePath = prWorktreePath(input.repoLocalPath, input.number);
  const headRef = `refs/ai-project-studio/pr/${input.number}`;

  // Best-effort favourite/publish of the source branch first, so the primary
  // `fetch origin <branch>` below can resolve it. The outcome is captured (not
  // swallowed) so that, if the fetch still fails, we can explain *why* the
  // favourite didn't help instead of a generic "please favourite it" message.
  let favouriteNote: string | null = null;
  if (deps.favouriteBranch) {
    onStatus?.({
      phase: 'favouriting',
      message: `Marking "${input.sourceBranch}" as a favourite…`,
    });
    try {
      const outcome = await deps.favouriteBranch();
      favouriteNote = outcome.message;
      onStatus?.({ phase: 'favouriting', message: outcome.message });
    } catch (err) {
      favouriteNote = err instanceof Error ? err.message : String(err);
      onStatus?.({
        phase: 'favouriting',
        message: `Couldn't favourite the branch: ${favouriteNote}`,
      });
    }
  }

  const candidateRefs =
    input.provider === 'github'
      ? [`pull/${input.number}/head`]
      : [input.sourceBranch, `refs/pull/${input.number}/merge`];

  onStatus?.({
    phase: 'fetching',
    message: `Fetching pull request #${input.number}…`,
  });
  let fetched = false;
  let lastFetch: GitRunResult = { code: 1, stdout: '', stderr: '' };
  for (const ref of candidateRefs) {
    lastFetch = await deps.git([
      '-C',
      input.repoLocalPath,
      'fetch',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      'origin',
      `+${ref}:${headRef}`,
    ]);
    if (lastFetch.code === 0) {
      fetched = true;
      break;
    }
  }
  if (!fetched) {
    throw new ValidationError(
      describeFetchFailure(input, lastFetch.stderr, favouriteNote),
    );
  }

  const revParse = await deps.git([
    '-C',
    input.repoLocalPath,
    'rev-parse',
    headRef,
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
        '--no-write-fetch-head',
        '--no-auto-maintenance',
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
  onStatus?.({ phase: 'preparing', message: 'Preparing the review worktree…' });
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
