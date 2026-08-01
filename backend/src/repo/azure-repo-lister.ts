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

/** Resolves the cached OAuth bearer token for an organization, or null. */
export type AzureTokenGetter = (org: string) => Promise<string | null>;

interface AdoProject {
  name?: string;
}

const API_VERSION = '7.1';

/** How many projects to request per page while enumerating an organization. */
export const PROJECTS_PAGE_SIZE = 200;

/** REST URL that lists a page of an organization's projects. */
export function projectsUrl(org: string, top: number, skip: number): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects` +
    `?api-version=${API_VERSION}&$top=${top}&$skip=${skip}`
  );
}

/**
 * The HTTPS clone URL of a project's default git repository. Azure DevOps names
 * a project's initial repository after the project itself, so we target that as
 * the repo to work on for the project the user picks.
 */
export function projectRepoUrl(org: string, project: string): string {
  return `https://dev.azure.com/${encodeURIComponent(
    org,
  )}/${encodeURIComponent(project)}/_git/${encodeURIComponent(project)}`;
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
 * Lists the projects in an Azure DevOps organization, one {@link RemoteRepo} per
 * project (targeting the project's default repository). Enumerating every repo
 * across every project does not scale to large organizations, so we just fetch
 * the project names — a single fast, paginated call — using the OAuth token GCM
 * already cached (via {@link AzureTokenGetter}) as a bearer credential. Both the
 * token source and HTTP transport are injected for testing.
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

  const repos: RemoteRepo[] = [];
  for (let skip = 0; ; skip += PROJECTS_PAGE_SIZE) {
    const res = await deps.httpGet(
      projectsUrl(trimmed, PROJECTS_PAGE_SIZE, skip),
      token,
    );
    if (res.status !== 200) {
      if (skip === 0) {
        throw new Error(
          `Failed to list Azure DevOps projects (HTTP ${res.status})`,
        );
      }
      break;
    }
    const page = extractValue<AdoProject>(res.body);
    for (const project of page) {
      const name = project?.name;
      if (!name) {
        continue;
      }
      repos.push({
        provider: 'azure-devops',
        name,
        remoteUrl: projectRepoUrl(trimmed, name),
        defaultBranch: null,
      });
    }
    if (page.length < PROJECTS_PAGE_SIZE) {
      break;
    }
  }
  return repos;
}
