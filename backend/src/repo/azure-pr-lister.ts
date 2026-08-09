import type {
  AzureHttpGetter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import type {
  RemotePullRequest,
  PullFilter,
} from './remote-pr-contract.js';

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

/** REST URL listing a repository's active pull requests, optionally filtered
 * server-side to those created by / awaiting review from a given user id. */
export function pullsUrl(
  target: AzureRepoTarget,
  opts: { creatorId?: string; reviewerId?: string } = {},
): string {
  const params = ['searchCriteria.status=active'];
  if (opts.creatorId) {
    params.push(`searchCriteria.creatorId=${encodeURIComponent(opts.creatorId)}`);
  }
  if (opts.reviewerId) {
    params.push(
      `searchCriteria.reviewerId=${encodeURIComponent(opts.reviewerId)}`,
    );
  }
  params.push('$top=1000');
  params.push(`api-version=${API_VERSION}`);
  return `${base(target)}?${params.join('&')}`;
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

interface AdoIdentity {
  id?: string;
  uniqueName?: string;
  displayName?: string;
}

/** The signed-in Azure DevOps user, used to flag their own / assigned PRs. */
export interface AzureUserIdentity {
  id: string | null;
  uniqueName: string | null;
}

interface AdoPull {
  pullRequestId?: number;
  title?: string;
  description?: string;
  sourceRefName?: string;
  createdBy?: AdoIdentity | null;
  reviewers?: AdoIdentity[] | null;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref;
}

/**
 * Whether an Azure identity ref refers to the signed-in user. Azure returns a
 * different `id` namespace depending on the token type (OAuth/Entra vs PAT), so
 * we match on the immutable id *or* the unique name (email/UPN), whichever we
 * were able to resolve — this makes "My PRs" / "Assigned to me" reliable.
 */
function identityMatches(
  ref: AdoIdentity | null | undefined,
  me: AzureUserIdentity,
): boolean {
  if (!ref) {
    return false;
  }
  if (me.id && ref.id === me.id) {
    return true;
  }
  if (
    me.uniqueName &&
    ref.uniqueName &&
    ref.uniqueName.toLowerCase() === me.uniqueName.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function mapPull(
  target: AzureRepoTarget,
  pull: AdoPull,
  me?: AzureUserIdentity,
): RemotePullRequest | null {
  const number = pull?.pullRequestId;
  const ref = pull?.sourceRefName;
  if (typeof number !== 'number' || !ref) {
    return null;
  }
  const isAuthor = me != null && identityMatches(pull.createdBy, me);
  const isReviewer =
    me != null && (pull.reviewers ?? []).some((r) => identityMatches(r, me));
  return {
    provider: 'azure-devops',
    number,
    title: pull.title ?? `PR #${number}`,
    url: pullWebUrl(target, number),
    sourceBranch: stripRefsHeads(ref),
    author: pull.createdBy?.displayName ?? null,
    isAuthor,
    isReviewer,
    ...(pull.description === undefined
      ? {}
      : { body: pull.description.trim() ? pull.description : null }),
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

/** REST URL returning the connection's authenticated user (for identity match). */
export function connectionDataUrl(org: string): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/connectionData?api-version=${API_VERSION}`
  );
}

/**
 * REST URL for the signed-in user's profile. Unlike `connectionData` (which
 * returns HTTP 400 for some organizations / OAuth token shapes), this endpoint
 * works org-agnostically and returns the identity `id` that matches a pull
 * request's `createdBy.id` — so it can be used directly as the server-side
 * `searchCriteria.creatorId` filter.
 */
export function profileUrl(): string {
  return `https://vssps.dev.azure.com/_apis/profile/profiles/me?api-version=${API_VERSION}`;
}

/** Extracts the signed-in user's id and email from the profile API response. */
export function parseProfileUser(body: unknown): AzureUserIdentity {
  if (body && typeof body === 'object') {
    const p = body as { id?: unknown; emailAddress?: unknown };
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    const uniqueName =
      typeof p.emailAddress === 'string' && p.emailAddress
        ? p.emailAddress
        : null;
    return { id, uniqueName };
  }
  return { id: null, uniqueName: null };
}

function accountProperty(user: Record<string, unknown>): string | null {
  const props = user.properties;
  if (props && typeof props === 'object') {
    const account = (props as { Account?: { $value?: unknown } }).Account;
    if (account && typeof account.$value === 'string' && account.$value) {
      return account.$value;
    }
  }
  return null;
}

/** Extracts the authenticated user's id and unique name from connectionData. */
export function parseAuthenticatedUser(body: unknown): AzureUserIdentity {
  if (body && typeof body === 'object') {
    const user = (body as { authenticatedUser?: Record<string, unknown> })
      .authenticatedUser;
    if (user && typeof user === 'object') {
      const id = typeof user.id === 'string' && user.id ? user.id : null;
      const uniqueName =
        (typeof user.uniqueName === 'string' && user.uniqueName
          ? user.uniqueName
          : null) ?? accountProperty(user);
      return { id, uniqueName };
    }
  }
  return { id: null, uniqueName: null };
}

/**
 * Resolves the signed-in user's identity, or null when it can't be determined.
 * The profile API is tried first (it returns the id that matches PR authorship
 * and works where `connectionData` returns HTTP 400); `connectionData` is a
 * fallback for organizations where the profile endpoint is unavailable.
 */
export async function fetchAzureUser(
  deps: AzurePullDeps,
  org: string,
): Promise<AzureUserIdentity | null> {
  const token = await deps.token(org);
  if (!token) {
    return null;
  }
  const profile = await deps.httpGet(profileUrl(), token);
  if (profile.status === 200) {
    const identity = parseProfileUser(profile.body);
    if (identity.id || identity.uniqueName) {
      return identity;
    }
  }
  const res = await deps.httpGet(connectionDataUrl(org), token);
  if (res.status !== 200) {
    return null;
  }
  const identity = parseAuthenticatedUser(res.body);
  return identity.id || identity.uniqueName ? identity : null;
}

/** Lists the active pull requests of an Azure DevOps repository. When a filter
 * and the signed-in user are supplied, the query is narrowed server-side (so it
 * works even on repositories with thousands of active PRs) and the result is
 * post-filtered by the enriched author/reviewer flags as a safety net. */
export async function listAzurePulls(
  deps: AzurePullDeps,
  target: AzureRepoTarget,
  opts: { currentUser?: AzureUserIdentity; filter?: PullFilter } = {},
): Promise<RemotePullRequest[]> {
  const me = opts.currentUser;
  const filter = opts.filter ?? 'all';
  const urlOpts: { creatorId?: string; reviewerId?: string } = {};
  if (me?.id && filter === 'mine') {
    urlOpts.creatorId = me.id;
  }
  if (me?.id && filter === 'assigned') {
    urlOpts.reviewerId = me.id;
  }
  const body = await authorizedGet(deps, target, pullsUrl(target, urlOpts));
  const pulls: RemotePullRequest[] = [];
  for (const item of extractValue<AdoPull>(body)) {
    const mapped = mapPull(target, item, me);
    if (mapped) {
      pulls.push(mapped);
    }
  }
  if (filter === 'mine') {
    return pulls.filter((p) => p.isAuthor);
  }
  if (filter === 'assigned') {
    return pulls.filter((p) => p.isReviewer);
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
