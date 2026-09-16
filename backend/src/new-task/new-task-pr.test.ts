import { describe, it, expect } from 'vitest';
import {
  createNewTaskPr,
  parseAzureErrorMessage,
  parseAzurePullId,
  parsePullNumberFromUrl,
  type NewTaskAzurePrDeps,
} from './new-task-pr.js';
import type { Repository } from '../repo/repo-contract.js';
import type { GhRunner } from '../github-auth/github-auth-service.js';

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    name: 'owner/app',
    provider: 'github',
    localPath: 'C:/work/app',
    remoteUrl: 'https://github.com/owner/app.git',
    defaultBranch: 'main',
    ...overrides,
  } as Repository;
}

const input = {
  repoId: 'r1',
  worktreePath: '/wt',
  branch: 'copilot/new-task-a1',
  baseBranch: 'main',
  title: 'Fix it',
  body: 'body',
};

const okGh: GhRunner = async () => ({ code: 0, stdout: '', stderr: '' });

/** An Azure REST double that records its POSTs and returns a canned response. */
function fakeAzure(
  response: { status: number; body: unknown },
  token: string | null = 'tok',
): NewTaskAzurePrDeps & { posts: { url: string; body: unknown }[] } {
  const posts: { url: string; body: unknown }[] = [];
  return {
    posts,
    token: async () => token,
    httpPost: async (url, _token, body) => {
      posts.push({ url, body });
      return response;
    },
  };
}

describe('parsePullNumberFromUrl', () => {
  it('reads the trailing pull number', () => {
    expect(parsePullNumberFromUrl('https://github.com/o/r/pull/42')).toBe(42);
    expect(parsePullNumberFromUrl('  https://github.com/o/r/pull/7\n')).toBe(7);
  });

  it('returns null when there is no number', () => {
    expect(parsePullNumberFromUrl('nonsense')).toBeNull();
    expect(parsePullNumberFromUrl('https://x/pull/0')).toBeNull();
  });
});

describe('parseAzurePullId', () => {
  it('reads a positive integer id', () => {
    expect(parseAzurePullId({ pullRequestId: 55 })).toBe(55);
  });

  it('rejects non-positive, non-integer, and non-object bodies', () => {
    expect(parseAzurePullId({ pullRequestId: 0 })).toBeNull();
    expect(parseAzurePullId({ pullRequestId: 1.5 })).toBeNull();
    expect(parseAzurePullId({ pullRequestId: 'x' })).toBeNull();
    expect(parseAzurePullId(null)).toBeNull();
  });
});

describe('parseAzureErrorMessage', () => {
  it('reads a non-empty message', () => {
    expect(parseAzureErrorMessage({ message: ' boom ' })).toBe('boom');
  });

  it('returns null for empty, missing, or non-object bodies', () => {
    expect(parseAzureErrorMessage({ message: '   ' })).toBeNull();
    expect(parseAzureErrorMessage({})).toBeNull();
    expect(parseAzureErrorMessage(null)).toBeNull();
  });
});

describe('createNewTaskPr — GitHub', () => {
  it('creates a GitHub PR and parses its number', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: 'https://github.com/owner/app/pull/99\n',
        stderr: '',
      };
    };
    const pr = createNewTaskPr({
      resolveRepo: () => repository(),
      gh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    const result = await pr.create(input);
    expect(result).toEqual({
      number: 99,
      url: 'https://github.com/owner/app/pull/99',
    });
    expect(calls[0]).toEqual([
      'pr', 'create', '--repo', 'owner/app', '--head', 'copilot/new-task-a1',
      '--base', 'main', '--title', 'Fix it', '--body', 'body',
    ]);
  });

  it('throws when gh fails', async () => {
    const gh: GhRunner = async () => ({ code: 1, stdout: '', stderr: 'nope' });
    const pr = createNewTaskPr({
      resolveRepo: () => repository(),
      gh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('nope');
  });

  it('uses a generic message when gh gives no stderr', async () => {
    const gh: GhRunner = async () => ({ code: 1, stdout: '', stderr: '' });
    const pr = createNewTaskPr({
      resolveRepo: () => repository(),
      gh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow(
      'Failed to open the pull request',
    );
  });

  it('throws when the created PR url has no number', async () => {
    const gh: GhRunner = async () => ({ code: 0, stdout: 'no-url', stderr: '' });
    const pr = createNewTaskPr({
      resolveRepo: () => repository(),
      gh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('number could not be read');
  });

  it('reports an empty response when gh prints nothing', async () => {
    const gh: GhRunner = async () => ({ code: 0, stdout: '   ', stderr: '' });
    const pr = createNewTaskPr({
      resolveRepo: () => repository(),
      gh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('(empty)');
  });
});

describe('createNewTaskPr — Azure DevOps', () => {
  const azureRepo = repository({
    provider: 'azure-devops',
    name: 'proj/app',
    remoteUrl: 'https://dev.azure.com/org/proj/_git/app',
  });

  it('creates an Azure PR and returns its web url', async () => {
    const azure = fakeAzure({ status: 201, body: { pullRequestId: 123 } });
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure,
    });
    const result = await pr.create(input);
    expect(result).toEqual({
      number: 123,
      url: 'https://dev.azure.com/org/proj/_git/app/pullrequest/123',
    });
    expect(azure.posts[0].url).toBe(
      'https://dev.azure.com/org/proj/_apis/git/repositories/app/pullrequests?api-version=7.1',
    );
    expect(azure.posts[0].body).toEqual({
      sourceRefName: 'refs/heads/copilot/new-task-a1',
      targetRefName: 'refs/heads/main',
      title: 'Fix it',
      description: 'body',
    });
  });

  it('accepts a 200 response too', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure: fakeAzure({ status: 200, body: { pullRequestId: 7 } }),
    });
    await expect(pr.create(input)).resolves.toMatchObject({ number: 7 });
  });

  it('fails clearly when the remote URL is not an Azure repo', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => repository({ provider: 'azure-devops', remoteUrl: '' }),
      gh: okGh,
      azure: fakeAzure({ status: 201, body: { pullRequestId: 1 } }),
    });
    await expect(pr.create(input)).rejects.toThrow(
      'Could not determine the Azure DevOps',
    );
  });

  it('fails when not signed in to Azure DevOps', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure: fakeAzure({ status: 201, body: {} }, null),
    });
    await expect(pr.create(input)).rejects.toThrow('Not signed in');
  });

  it('surfaces the Azure error message on failure', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure: fakeAzure({ status: 409, body: { message: 'PR already exists' } }),
    });
    await expect(pr.create(input)).rejects.toThrow('PR already exists');
  });

  it('falls back to an HTTP status message when none is provided', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure: fakeAzure({ status: 500, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('HTTP 500');
  });

  it('throws when the response omits the pull id', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () => azureRepo,
      gh: okGh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('id could not be read');
  });
});

describe('createNewTaskPr — unsupported providers', () => {
  it('rejects providers that are neither GitHub nor Azure DevOps', async () => {
    const pr = createNewTaskPr({
      resolveRepo: () =>
        repository({ provider: 'gitlab' as Repository['provider'] }),
      gh: okGh,
      azure: fakeAzure({ status: 201, body: {} }),
    });
    await expect(pr.create(input)).rejects.toThrow('is not supported for');
  });
});
