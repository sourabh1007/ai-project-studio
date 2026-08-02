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
 * review reflects the latest remote state even when a local `pr-<n>` branch
 * already exists. A pre-existing worktree is reused but hard-reset to the freshly
 * fetched head; otherwise the worktree is created with its branch (re)pointed at
 * that head.
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
  const branch = `pr-${input.number}`;

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

  if (deps.pathExists(worktreePath)) {
    const reset = await deps.git([
      '-c',
      'core.longpaths=true',
      '-C',
      worktreePath,
      'reset',
      '--hard',
      headSha,
    ]);
    if (reset.code !== 0) {
      throw new ValidationError(
        describeWorktreeFailure(
          reset.stderr,
          'Failed to update the review worktree',
        ),
      );
    }
    return { worktreePath, branch };
  }

  const add = await deps.git([
    '-c',
    'core.longpaths=true',
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
    throw new ValidationError(
      describeWorktreeFailure(
        add.stderr,
        'Failed to create the review worktree',
      ),
    );
  }
  return { worktreePath, branch };
}
