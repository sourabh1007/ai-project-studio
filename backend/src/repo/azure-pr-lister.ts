import type {
  AzureHttpGetter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type { RemotePullRequest } from './remote-pr-contract.js';

const API_VERSION = '7.1';

/** The org / project / repository a pull-request query targets. */
export interface AzureRepoTarget {
  org: string;
  project: string;
  repo: string;
}

/**
 * Extracts the org / project / repo from an Azure DevOps HTTPS clone URL. Both
 * the modern `dev.azure.com/{org}/{project}/_git/{repo}` and the legacy
 * `{org}.visualstudio.com/{project}/_git/{repo}` shapes are recognised.
 */
export function parseAzureRepoUrl(remoteUrl: string): AzureRepoTarget | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  const gitIndex = segments.indexOf('_git');
  if (gitIndex < 0 || gitIndex + 1 >= segments.length) {
    return null;
  }
  const repo = segments[gitIndex + 1].replace(/\.git$/, '');
  const project = segments[gitIndex - 1];
  const host = url.hostname.toLowerCase();
  let org: string;
  if (host.endsWith('.visualstudio.com')) {
    org = host.slice(0, -'.visualstudio.com'.length);
  } else {
    // dev.azure.com/{org}/{project}/_git/{repo}: org is the first segment.
    if (gitIndex < 2) {
      return null;
    }
    org = segments[0];
  }
  if (!org || !project || !repo) {
    return null;
  }
  return { org, project, repo };
}

function base(target: AzureRepoTarget): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullrequests`
  );
}

/** REST URL listing a repository's active pull requests. */
export function pullsUrl(target: AzureRepoTarget): string {
  return `${base(target)}?searchCriteria.status=active&api-version=${API_VERSION}`;
}

/** REST URL for a single pull request by id. */
export function pullUrl(target: AzureRepoTarget, id: number): string {
  return `${base(target)}/${id}?api-version=${API_VERSION}`;
}

/** Web URL a user opens to view the pull request in the browser. */
export function pullWebUrl(target: AzureRepoTarget, id: number): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(
      target.repo,
    )}/pullrequest/${id}`
  );
}

interface AdoPull {
  pullRequestId?: number;
  title?: string;
  sourceRefName?: string;
  createdBy?: { displayName?: string } | null;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref;
}

function mapPull(
  target: AzureRepoTarget,
  pull: AdoPull,
): RemotePullRequest | null {
  const number = pull?.pullRequestId;
  const ref = pull?.sourceRefName;
  if (typeof number !== 'number' || !ref) {
    return null;
  }
  return {
    provider: 'azure-devops',
    number,
    title: pull.title ?? `PR #${number}`,
    url: pullWebUrl(target, number),
    sourceBranch: stripRefsHeads(ref),
    author: pull.createdBy?.displayName ?? null,
  };
}

function extractValue<T>(body: unknown): T[] {
  if (
    body &&
    typeof body === 'object' &&
    Array.isArray((body as { value?: unknown }).value)
  ) {
    return (body as { value: T[] }).value;
  }
  return [];
}

export interface AzurePullDeps {
  token: AzureTokenGetter;
  httpGet: AzureHttpGetter;
}

async function authorizedGet(
  deps: AzurePullDeps,
  target: AzureRepoTarget,
  url: string,
): Promise<unknown> {
  const token = await deps.token(target.org);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const res = await deps.httpGet(url, token);
  if (res.status !== 200) {
    throw new Error(
      `Failed to query Azure DevOps pull requests (HTTP ${res.status})`,
    );
  }
  return res.body;
}

/** Lists the active pull requests of an Azure DevOps repository. */
export async function listAzurePulls(
  deps: AzurePullDeps,
  target: AzureRepoTarget,
): Promise<RemotePullRequest[]> {
  const body = await authorizedGet(deps, target, pullsUrl(target));
  const pulls: RemotePullRequest[] = [];
  for (const item of extractValue<AdoPull>(body)) {
    const mapped = mapPull(target, item);
    if (mapped) {
      pulls.push(mapped);
    }
  }
  return pulls;
}

/** Fetches a single Azure DevOps pull request by id, or null when not found. */
export async function getAzurePull(
  deps: AzurePullDeps,
  target: AzureRepoTarget,
  id: number,
): Promise<RemotePullRequest | null> {
  const token = await deps.token(target.org);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const res = await deps.httpGet(pullUrl(target, id), token);
  if (res.status !== 200) {
    return null;
  }
  return mapPull(target, res.body as AdoPull);
}
