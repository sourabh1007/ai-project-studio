import type { RemoteRepo } from './remote-repo-contract.js';

export interface AzureHttpResponse {
  status: number;
  body: unknown;
}

/** Performs an authenticated GET against the Azure DevOps REST API. */
export type AzureHttpGetter = (
  url: string,
  token: string,
) => Promise<AzureHttpResponse>;

/**
 * Performs an authenticated POST against the Azure DevOps REST API, sending
 * `body` as JSON. Used to create pull-request comment threads.
 */
export type AzureHttpPoster = (
  url: string,
  token: string,
  body: unknown,
) => Promise<AzureHttpResponse>;

/**
 * Performs an authenticated PATCH against the Azure DevOps REST API, sending
 * `body` as JSON. Used to resolve / reopen a pull-request comment thread.
 */
export type AzureHttpPatcher = (
  url: string,
  token: string,
  body: unknown,
) => Promise<AzureHttpResponse>;

/** Performs an authenticated PUT against the Azure DevOps REST API. */
export type AzureHttpPutter = (
  url: string,
  token: string,
  body: unknown,
) => Promise<AzureHttpResponse>;

/** Resolves the cached OAuth bearer token for an organization, or null. */
export type AzureTokenGetter = (org: string) => Promise<string | null>;

interface AdoProjectRef {
  name?: string;
}

interface AdoRepository {
  name?: string;
  project?: AdoProjectRef | null;
  defaultBranch?: string | null;
  remoteUrl?: string | null;
  webUrl?: string | null;
  isDisabled?: boolean | null;
}

const API_VERSION = '7.1';

/**
 * REST URL that lists every git repository across every project in an
 * organization. Unlike the projects endpoint this is not paginated — Azure
 * DevOps returns the full set in a single response — so one call enumerates the
 * whole organization.
 */
export function repositoriesUrl(org: string): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/git/repositories` +
    `?api-version=${API_VERSION}`
  );
}

/**
 * The HTTPS clone URL of a repository, used as a fallback when Azure DevOps does
 * not return a `webUrl`. Mirrors the browser-facing
 * `dev.azure.com/{org}/{project}/_git/{repo}` shape (no `user@` prefix).
 */
export function repoCloneUrl(
  org: string,
  project: string,
  repo: string,
): string {
  return `https://dev.azure.com/${encodeURIComponent(
    org,
  )}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref;
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

/**
 * Lists every git repository in an Azure DevOps organization, one
 * {@link RemoteRepo} per repository. A single project can hold many repositories
 * (and a repository is rarely named after its project), so enumerating projects
 * alone misses most repos — this queries the org-wide repositories endpoint so
 * repos like `CosmosDB/geneva_config` are found. Each repo is labelled
 * `project/repo` for disambiguation, since repository names can collide across
 * projects. The OAuth token GCM already cached (via {@link AzureTokenGetter}) is
 * used as a bearer credential; both the token source and HTTP transport are
 * injected for testing.
 */
export async function listAzureRepos(
  deps: { token: AzureTokenGetter; httpGet: AzureHttpGetter },
  org: string,
): Promise<RemoteRepo[]> {
  const trimmed = org.trim();
  if (!trimmed) {
    throw new Error('An Azure DevOps organization is required');
  }
  const token = await deps.token(trimmed);
  if (!token) {
    throw new Error(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }

  const res = await deps.httpGet(repositoriesUrl(trimmed), token);
  if (res.status !== 200) {
    throw new Error(
      `Failed to list Azure DevOps repositories (HTTP ${res.status})`,
    );
  }

  const repos: RemoteRepo[] = [];
  for (const repo of extractValue<AdoRepository>(res.body)) {
    const name = repo?.name;
    const project = repo?.project?.name;
    if (!name || !project || repo.isDisabled) {
      continue;
    }
    const remoteUrl =
      (repo.webUrl && repo.webUrl.trim()) ||
      repoCloneUrl(trimmed, project, name);
    repos.push({
      provider: 'azure-devops',
      name: `${project}/${name}`,
      remoteUrl,
      defaultBranch: repo.defaultBranch
        ? stripRefsHeads(repo.defaultBranch)
        : null,
    });
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}
