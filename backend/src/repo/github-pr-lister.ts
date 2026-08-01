import type { GhRunner } from '../github-auth/github-auth-service.js';
import type { RemotePullRequest } from './remote-pr-contract.js';

interface GhPullJson {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  author?: { login?: string; name?: string } | null;
}

/** The `--json` fields requested from `gh` for a pull request. */
const PULL_JSON_FIELDS = 'number,title,url,headRefName,author';

function mapPull(item: GhPullJson): RemotePullRequest | null {
  const number = item?.number;
  const sourceBranch = item?.headRefName;
  if (typeof number !== 'number' || !sourceBranch) {
    return null;
  }
  const author = item.author?.name || item.author?.login || null;
  return {
    provider: 'github',
    number,
    title: item.title ?? `PR #${number}`,
    url: item.url ?? '',
    sourceBranch,
    author,
  };
}

/** Parses the JSON array `gh pr list --json ...` writes to stdout. */
export function parseGithubPulls(stdout: string): RemotePullRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const pulls: RemotePullRequest[] = [];
  for (const item of parsed as GhPullJson[]) {
    const pull = mapPull(item);
    if (pull) {
      pulls.push(pull);
    }
  }
  return pulls;
}

/** Parses the single JSON object `gh pr view --json ...` writes to stdout. */
export function parseGithubPull(stdout: string): RemotePullRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  return mapPull(parsed as GhPullJson);
}

/**
 * Lists the open pull requests of a GitHub repository via the `gh` CLI (the same
 * login the IDE already uses). `repo` is the `owner/name` slug. The runner is
 * injected so this stays testable.
 */
export async function listGithubPulls(
  run: GhRunner,
  repo: string,
  opts: { limit?: number } = {},
): Promise<RemotePullRequest[]> {
  const limit = opts.limit ?? 100;
  const res = await run([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    PULL_JSON_FIELDS,
  ]);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Failed to list pull requests');
  }
  return parseGithubPulls(res.stdout);
}

/** Fetches a single GitHub pull request by number, or null when not found. */
export async function getGithubPull(
  run: GhRunner,
  repo: string,
  number: number,
): Promise<RemotePullRequest | null> {
  const res = await run([
    'pr',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    PULL_JSON_FIELDS,
  ]);
  if (res.code !== 0) {
    return null;
  }
  return parseGithubPull(res.stdout);
}
