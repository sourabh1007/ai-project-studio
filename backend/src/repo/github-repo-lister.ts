import type { GhRunner } from '../github-auth/github-auth-service.js';
import { AuthRequiredError, ProviderError } from '../kernel/error-types.js';
import type { RemoteRepo } from './remote-repo-contract.js';

/** Shape of one repository object from the GitHub REST `/user/repos` endpoint. */
interface GhRestRepoJson {
  full_name?: string;
  clone_url?: string;
  html_url?: string;
  default_branch?: string | null;
  archived?: boolean;
}

/**
 * Parses the JSON array that `gh api --paginate /user/repos` writes to stdout.
 * `--paginate` merges every page into a single JSON array, so a plain
 * `JSON.parse` yields all accessible repositories across the pages.
 */
export function parseGithubRepos(stdout: string): RemoteRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const repos: RemoteRepo[] = [];
  for (const item of parsed as GhRestRepoJson[]) {
    // Preserve the previous `--no-archived` behaviour now that the REST
    // endpoint returns archived repositories too.
    if (item?.archived) {
      continue;
    }
    const name = item?.full_name;
    const url = item?.clone_url ?? item?.html_url;
    if (!name || !url) {
      continue;
    }
    repos.push({
      provider: 'github',
      name,
      remoteUrl: url.endsWith('.git') ? url : `${url}.git`,
      defaultBranch: item.default_branch ?? null,
    });
  }
  return repos;
}

/**
 * Lists every GitHub repository the authenticated user can access — repos they
 * own, repos they collaborate on, and repos from organizations they belong to —
 * via the `gh` CLI (the same login the IDE already uses).
 *
 * `gh repo list` only returns repositories the user *owns*, so it hides org and
 * collaborator repos. The REST `/user/repos` endpoint with the full affiliation
 * set is the surface that reports the user's complete access. `--paginate`
 * walks every page and merges them into one JSON array. The runner is injected
 * so this stays testable.
 */
export async function listGithubRepos(
  run: GhRunner,
  opts: { perPage?: number } = {},
): Promise<RemoteRepo[]> {
  const perPage = opts.perPage ?? 100;
  const res = await run([
    'api',
    '--paginate',
    `user/repos?per_page=${perPage}&affiliation=owner,collaborator,organization_member&sort=full_name`,
  ]);
  if (res.code !== 0) {
    const stderr = res.stderr.trim();
    // `gh` exits non-zero with an auth hint when the user hasn't logged in.
    // Surface that as an auth-required error (HTTP 401) so the UI can prompt a
    // sign-in instead of showing a generic "internal server error".
    if (isGithubAuthError(stderr)) {
      throw new AuthRequiredError(
        'Not signed in to GitHub. Sign in to GitHub, then try again.',
        'github',
      );
    }
    throw new ProviderError(
      stderr || 'Could not load GitHub repositories. Please try again.',
    );
  }
  return parseGithubRepos(res.stdout);
}

/**
 * True when `gh`'s stderr indicates the failure is an authentication problem
 * (not signed in / no valid token) rather than a transient/API error.
 */
function isGithubAuthError(stderr: string): boolean {
  return /auth login|not logged in|authentication|requires? authentication|gh auth|no accounts|logged into/i.test(
    stderr,
  );
}
