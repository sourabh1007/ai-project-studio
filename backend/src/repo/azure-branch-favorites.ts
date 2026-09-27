import { parseAzureRepoUrl } from './azure-pr-lister.js';
import type {
  AzureHttpGetter,
  AzureHttpPoster,
  AzureTokenGetter,
} from './azure-repo-lister.js';

const API_VERSION = '7.1';

/** Authenticated Azure DevOps REST access needed to favourite a branch. */
export interface AzureBranchFavoriteDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
  httpPost: AzureHttpPoster;
}

export interface FavouriteBranchInput {
  /** The repository's HTTPS clone URL (org/project/repo are parsed from it). */
  remoteUrl: string;
  /** The branch to favourite, with or without a `refs/heads/` prefix. */
  branch: string;
}

export type FavouriteBranchStatus =
  | 'favourited'
  | 'already'
  | 'skipped'
  | 'failed';

export interface FavouriteBranchResult {
  status: FavouriteBranchStatus;
  message: string;
}

/**
 * REST URL that resolves a repository's metadata (we need its GUID, since the
 * favourites API keys on `repositoryId`, not the repo name).
 */
export function repositoryUrl(
  org: string,
  project: string,
  repo: string,
): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/${encodeURIComponent(project)}/_apis/git/repositories` +
    `/${encodeURIComponent(repo)}?api-version=${API_VERSION}`
  );
}

/** REST URL that creates a git ref (branch/tag) favourite. */
export function favoritesUrl(org: string, project: string): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/${encodeURIComponent(project)}/_apis/git/favorites/refs` +
    `?api-version=${API_VERSION}`
  );
}

/** Normalises a branch name to the full `refs/heads/<name>` ref the API wants. */
export function toBranchRef(branch: string): string {
  const trimmed = branch.trim();
  return trimmed.startsWith('refs/') ? trimmed : `refs/heads/${trimmed}`;
}

/**
 * Marks a branch as a favourite in Azure DevOps so the git server advertises its
 * ref. Large Azure DevOps repositories (e.g. CosmosDB) do not advertise every
 * `users/*` topic branch, so `git fetch origin <branch>` fails with "couldn't
 * find remote ref" until the branch is favourited/published. Favouriting it
 * first lets the subsequent fetch resolve the branch, yielding a pushable review
 * worktree instead of a detached merge-ref checkout.
 *
 * This is best-effort: a caller checks the branch out regardless of the outcome,
 * so every failure mode resolves to a descriptive {@link FavouriteBranchResult}
 * rather than throwing. An "already a favourite" response (HTTP 409) is a
 * success, not an error.
 */
export async function favouriteAzureBranch(
  deps: AzureBranchFavoriteDeps,
  input: FavouriteBranchInput,
): Promise<FavouriteBranchResult> {
  const target = parseAzureRepoUrl(input.remoteUrl);
  if (!target) {
    return {
      status: 'skipped',
      message: 'Not an Azure DevOps repository, so no branch to favourite.',
    };
  }
  const branch = input.branch.trim();
  if (!branch) {
    return { status: 'skipped', message: 'No source branch to favourite.' };
  }
  const token = await deps.token(target.org);
  if (!token) {
    return {
      status: 'skipped',
      message: `Not signed in to Azure DevOps "${target.org}".`,
    };
  }

  const repoRes = await deps.httpGet(
    repositoryUrl(target.org, target.project, target.repo),
    token,
  );
  const repositoryId = (repoRes.body as { id?: unknown } | null)?.id;
  if (
    repoRes.status < 200 ||
    repoRes.status >= 300 ||
    typeof repositoryId !== 'string' ||
    repositoryId.length === 0
  ) {
    return {
      status: 'failed',
      message: `Couldn't resolve "${target.repo}" to favourite its branch (HTTP ${repoRes.status}).`,
    };
  }

  const favRes = await deps.httpPost(
    favoritesUrl(target.org, target.project),
    token,
    { name: toBranchRef(branch), repositoryId, type: 'ref' },
  );
  if (favRes.status === 409) {
    return {
      status: 'already',
      message: `Branch "${branch}" is already a favourite.`,
    };
  }
  if (favRes.status >= 200 && favRes.status < 300) {
    return { status: 'favourited', message: `Marked "${branch}" as favourite.` };
  }
  return {
    status: 'failed',
    message: `Couldn't favourite branch "${branch}" (HTTP ${favRes.status}).`,
  };
}
