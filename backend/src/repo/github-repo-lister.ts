import type { GhRunner } from '../github-auth/github-auth-service.js';
import { AuthRequiredError } from '../kernel/error-types.js';
import type { RemoteRepo } from './remote-repo-contract.js';

interface GhRepoJson {
  nameWithOwner?: string;
  url?: string;
  defaultBranchRef?: { name?: string } | null;
}

/** Parses the JSON array `gh repo list --json ...` writes to stdout. */
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
  for (const item of parsed as GhRepoJson[]) {
    const name = item?.nameWithOwner;
    const url = item?.url;
    if (!name || !url) {
      continue;
    }
    repos.push({
      provider: 'github',
      name,
      remoteUrl: url.endsWith('.git') ? url : `${url}.git`,
      defaultBranch: item.defaultBranchRef?.name ?? null,
    });
  }
  return repos;
}

/**
 * Lists the authenticated user's GitHub repositories via the `gh` CLI (the same
 * login the IDE already uses). The runner is injected so this stays testable.
 */
export async function listGithubRepos(
  run: GhRunner,
  opts: { limit?: number } = {},
): Promise<RemoteRepo[]> {
  const limit = opts.limit ?? 100;
  const res = await run([
    'repo',
    'list',
    '--no-archived',
    '--limit',
    String(limit),
    '--json',
    'nameWithOwner,url,defaultBranchRef',
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
    throw new Error(stderr || 'Failed to list GitHub repositories');
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
