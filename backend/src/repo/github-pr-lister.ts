import type { GhRunner } from '../github-auth/github-auth-service.js';
import type {
  RemotePullRequest,
  PullFilter,
} from './remote-pr-contract.js';

interface GhReviewRequest {
  login?: string;
  slug?: string;
}

interface GhPullJson {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  body?: string;
  author?: { login?: string; name?: string } | null;
  reviewRequests?: GhReviewRequest[] | null;
}

/** The `--json` fields requested from `gh` for a pull request. */
const PULL_JSON_FIELDS =
  'number,title,url,headRefName,baseRefName,author,reviewRequests';

/** Single-PR fetch also pulls the description body for the problem statement. */
const PULL_VIEW_JSON_FIELDS = `${PULL_JSON_FIELDS},body`;

function mapPull(item: GhPullJson, currentUser?: string): RemotePullRequest | null {
  const number = item?.number;
  const sourceBranch = item?.headRefName;
  if (typeof number !== 'number' || !sourceBranch) {
    return null;
  }
  const login = item.author?.login ?? null;
  const author = item.author?.name || login || null;
  const me = currentUser?.toLowerCase();
  const isAuthor = me != null && login != null && login.toLowerCase() === me;
  const isReviewer =
    me != null &&
    (item.reviewRequests ?? []).some(
      (r) => (r.login ?? '').toLowerCase() === me,
    );
  return {
    provider: 'github',
    number,
    title: item.title ?? `PR #${number}`,
    url: item.url ?? '',
    sourceBranch,
    targetBranch: item.baseRefName ?? null,
    author,
    isAuthor,
    isReviewer,
    // Only present on single-PR fetches (list requests omit the body field).
    ...(item.body === undefined
      ? {}
      : { body: item.body.trim() ? item.body : null }),
  };
}

/** Parses the JSON array `gh pr list --json ...` writes to stdout. */
export function parseGithubPulls(
  stdout: string,
  currentUser?: string,
): RemotePullRequest[] {
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
    const pull = mapPull(item, currentUser);
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
 * injected so this stays testable. When `currentUser` is supplied each PR is
 * flagged as authored-by / review-requested-of that login so the UI can group
 * them into "My PRs" / "Assigned to me".
 */
export async function listGithubPulls(
  run: GhRunner,
  repo: string,
  opts: { limit?: number; currentUser?: string; filter?: PullFilter } = {},
): Promise<RemotePullRequest[]> {
  const limit = opts.limit ?? 100;
  const filter = opts.filter ?? 'all';
  const scope: string[] =
    filter === 'mine'
      ? ['--state', 'open', '--author', '@me']
      : filter === 'assigned'
        ? ['--search', 'is:open review-requested:@me']
        : ['--state', 'open'];
  const res = await run([
    'pr',
    'list',
    '--repo',
    repo,
    ...scope,
    '--limit',
    String(limit),
    '--json',
    PULL_JSON_FIELDS,
  ]);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Failed to list pull requests');
  }
  return parseGithubPulls(res.stdout, opts.currentUser);
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
    PULL_VIEW_JSON_FIELDS,
  ]);
  if (res.code !== 0) {
    return null;
  }
  return parseGithubPull(res.stdout);
}
