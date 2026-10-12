import type { GhRunner } from '../github-auth/github-auth-service.js';
import type { RemoteIssue } from './remote-import-contract.js';

interface GhIssueJson {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  createdAt?: string;
  author?: { login?: string } | null;
  assignees?: { login?: string }[] | null;
  labels?: { name?: string }[] | null;
}

/** The `--json` fields requested from `gh` for an issue. */
const ISSUE_JSON_FIELDS =
  'number,title,url,state,createdAt,author,assignees,labels';

function mapIssue(item: GhIssueJson): RemoteIssue | null {
  const number = item?.number;
  if (typeof number !== 'number') {
    return null;
  }
  const assignees = (item.assignees ?? [])
    .map((a) => a?.login)
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
  const labels = (item.labels ?? [])
    .map((l) => l?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return {
    provider: 'github',
    number,
    title: item.title ?? `Issue #${number}`,
    url: item.url ?? '',
    state: item.state ?? 'open',
    author: item.author?.login ?? null,
    assignees,
    labels,
    createdAt: item.createdAt ?? null,
  };
}

/** Parses the JSON array `gh issue list --json ...` writes to stdout. */
export function parseGithubIssues(stdout: string): RemoteIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const issues: RemoteIssue[] = [];
  for (const item of parsed as GhIssueJson[]) {
    const issue = mapIssue(item);
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

/** Which subset of a repository's open issues to list. */
export type IssueFilter = 'mine' | 'assigned' | 'all';

/**
 * Lists the open issues of a GitHub repository via the `gh` CLI (the same login
 * the IDE already uses). `repo` is the `owner/name` slug. The `mine` filter
 * narrows to issues the user authored and `assigned` to those assigned to them.
 */
export async function listGithubIssues(
  run: GhRunner,
  repo: string,
  opts: { limit?: number; filter?: IssueFilter } = {},
): Promise<RemoteIssue[]> {
  const limit = opts.limit ?? 100;
  const filter = opts.filter ?? 'all';
  const scope: string[] =
    filter === 'mine'
      ? ['--author', '@me']
      : filter === 'assigned'
        ? ['--assignee', '@me']
        : [];
  const res = await run([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    ...scope,
    '--limit',
    String(limit),
    '--json',
    ISSUE_JSON_FIELDS,
  ]);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || 'Failed to list issues');
  }
  return parseGithubIssues(res.stdout);
}
