import { ValidationError } from '../kernel/error-types.js';
import type { GhRunner } from '../github-auth/github-auth-service.js';
import { parseAzureRepoUrl, pullWebUrl } from '../repo/azure-pr-lister.js';
import type {
  AzureHttpPoster,
  AzureTokenGetter,
} from '../repo/azure-repo-lister.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  NewTaskPrPort,
  NewTaskPullRequest,
} from './new-task-contract.js';

/** Authenticated Azure DevOps REST access for opening a pull request. */
export interface NewTaskAzurePrDeps {
  token: AzureTokenGetter;
  httpPost: AzureHttpPoster;
}

export interface NewTaskPrDeps {
  /** Resolves the repository a run belongs to (for provider + slug). */
  resolveRepo(repoId: string): Repository;
  /** The `gh` CLI runner (GitHub provider). */
  gh: GhRunner;
  /** Azure DevOps REST access (azure-devops provider). */
  azure: NewTaskAzurePrDeps;
}

/** Azure DevOps REST API version this module targets. */
const AZURE_API_VERSION = '7.1';

/** Extract the trailing pull-request number from a `gh pr create` URL. */
export function parsePullNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)\b/.exec(url.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Read `pullRequestId` from an Azure "create pull request" response body. */
export function parseAzurePullId(body: unknown): number | null {
  if (body && typeof body === 'object') {
    const id = (body as { pullRequestId?: unknown }).pullRequestId;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      return id;
    }
  }
  return null;
}

/** Read the human-readable error message from an Azure REST error body. */
export function parseAzureErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }
  return null;
}

async function createGithubPr(
  deps: NewTaskPrDeps,
  repo: Repository,
  input: Parameters<NewTaskPrPort['create']>[0],
): Promise<NewTaskPullRequest> {
  const res = await deps.gh([
    'pr',
    'create',
    '--repo',
    repo.name,
    '--head',
    input.branch,
    '--base',
    input.baseBranch,
    '--title',
    input.title,
    '--body',
    input.body,
  ]);
  if (res.code !== 0) {
    throw new ValidationError(
      res.stderr.trim() || 'Failed to open the pull request',
    );
  }
  const url = res.stdout.trim();
  const number = parsePullNumberFromUrl(url);
  if (number === null) {
    throw new ValidationError(
      `The pull request was created but its number could not be read ` +
        `from the response: ${url || '(empty)'}`,
    );
  }
  return { number, url };
}

async function createAzurePr(
  deps: NewTaskPrDeps,
  repo: Repository,
  input: Parameters<NewTaskPrPort['create']>[0],
): Promise<NewTaskPullRequest> {
  const target = parseAzureRepoUrl(repo.remoteUrl);
  if (!target) {
    throw new ValidationError(
      `Could not determine the Azure DevOps project/repository from the ` +
        `remote URL: ${repo.remoteUrl || '(empty)'}`,
    );
  }
  const token = await deps.azure.token(target.org);
  if (!token) {
    throw new ValidationError(
      'Not signed in to Azure DevOps. Sign in first, then try again.',
    );
  }
  const url =
    `https://dev.azure.com/${encodeURIComponent(target.org)}` +
    `/${encodeURIComponent(target.project)}/_apis/git/repositories` +
    `/${encodeURIComponent(target.repo)}/pullrequests` +
    `?api-version=${AZURE_API_VERSION}`;
  const res = await deps.azure.httpPost(url, token, {
    sourceRefName: `refs/heads/${input.branch}`,
    targetRefName: `refs/heads/${input.baseBranch}`,
    title: input.title,
    description: input.body,
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new ValidationError(
      parseAzureErrorMessage(res.body) ??
        `Failed to open the pull request (HTTP ${res.status}).`,
    );
  }
  const number = parseAzurePullId(res.body);
  if (number === null) {
    throw new ValidationError(
      'The pull request was created but its id could not be read from the ' +
        'Azure DevOps response.',
    );
  }
  return { number, url: pullWebUrl(target, number) };
}

/**
 * Opens a pull request for a pushed branch, dispatched by the repository's
 * provider. GitHub is driven through the same `gh` CLI login the IDE already
 * uses (`gh pr create` prints the new PR's URL); Azure DevOps posts to the REST
 * "create pull request" endpoint with the cached OAuth token the rest of the
 * Azure integration shares. Any other provider fails with a clear message
 * rather than silently.
 */
export function createNewTaskPr(deps: NewTaskPrDeps): NewTaskPrPort {
  return {
    async create(input): Promise<NewTaskPullRequest> {
      const repo = deps.resolveRepo(input.repoId);
      if (repo.provider === 'github') {
        return createGithubPr(deps, repo, input);
      }
      if (repo.provider === 'azure-devops') {
        return createAzurePr(deps, repo, input);
      }
      throw new ValidationError(
        `Opening a pull request is not supported for "${repo.provider}" ` +
          `repositories.`,
      );
    },
  };
}
