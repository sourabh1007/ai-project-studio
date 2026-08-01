import { describe, it, expect } from 'vitest';
import type {
  AzureHttpGetter,
  AzureTokenGetter,
} from './azure-repo-lister.js';
import {
  parseAzureRepoUrl,
  pullsUrl,
  pullUrl,
  pullWebUrl,
  listAzurePulls,
  getAzurePull,
  type AzureRepoTarget,
} from './azure-pr-lister.js';

const target: AzureRepoTarget = {
  org: 'myorg',
  project: 'myproject',
  repo: 'myrepo',
};

const token: AzureTokenGetter = () => Promise.resolve('tok');
const noToken: AzureTokenGetter = () => Promise.resolve(null);

function http(status: number, body: unknown): AzureHttpGetter {
  return () => Promise.resolve({ status, body });
}

const pullBody = {
  value: [
    {
      pullRequestId: 42,
      title: 'Add feature',
      sourceRefName: 'refs/heads/topic/x',
      createdBy: { displayName: 'Ada' },
    },
    { pullRequestId: 7 }, // missing ref -> skipped
  ],
};

describe('parseAzureRepoUrl', () => {
  it('parses a dev.azure.com URL', () => {
    expect(
      parseAzureRepoUrl('https://dev.azure.com/myorg/myproject/_git/myrepo'),
    ).toEqual(target);
  });

  it('parses a legacy visualstudio.com URL', () => {
    expect(
      parseAzureRepoUrl('https://myorg.visualstudio.com/myproject/_git/myrepo'),
    ).toEqual(target);
  });

  it('strips a trailing .git and decodes segments', () => {
    expect(
      parseAzureRepoUrl(
        'https://dev.azure.com/myorg/My%20Project/_git/myrepo.git',
      ),
    ).toEqual({ org: 'myorg', project: 'My Project', repo: 'myrepo' });
  });

  it('returns null for a malformed URL', () => {
    expect(parseAzureRepoUrl('not a url')).toBeNull();
  });

  it('returns null when there is no _git segment', () => {
    expect(parseAzureRepoUrl('https://dev.azure.com/org/project')).toBeNull();
  });

  it('returns null when _git is the last segment', () => {
    expect(
      parseAzureRepoUrl('https://dev.azure.com/org/project/_git'),
    ).toBeNull();
  });

  it('returns null for dev.azure.com without an org segment', () => {
    expect(parseAzureRepoUrl('https://dev.azure.com/project/_git/repo')).toBeNull();
  });

  it('returns null when the repo name is empty after stripping', () => {
    expect(
      parseAzureRepoUrl('https://dev.azure.com/org/project/_git/.git'),
    ).toBeNull();
  });
});

describe('url builders', () => {
  it('builds list, single and web URLs', () => {
    expect(pullsUrl(target)).toBe(
      'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests?searchCriteria.status=active&api-version=7.1',
    );
    expect(pullUrl(target, 5)).toBe(
      'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests/5?api-version=7.1',
    );
    expect(pullWebUrl(target, 5)).toBe(
      'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/5',
    );
  });
});

describe('listAzurePulls', () => {
  it('maps active pull requests and skips malformed ones', async () => {
    const pulls = await listAzurePulls(
      { token, httpGet: http(200, pullBody) },
      target,
    );
    expect(pulls).toEqual([
      {
        provider: 'azure-devops',
        number: 42,
        title: 'Add feature',
        url: 'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42',
        sourceBranch: 'topic/x',
        author: 'Ada',
      },
    ]);
  });

  it('returns an empty array when the body has no value array', async () => {
    const pulls = await listAzurePulls(
      { token, httpGet: http(200, {}) },
      target,
    );
    expect(pulls).toEqual([]);
  });

  it('throws when not signed in', async () => {
    await expect(
      listAzurePulls({ token: noToken, httpGet: http(200, pullBody) }, target),
    ).rejects.toThrow('Not signed in');
  });

  it('throws on a non-200 response', async () => {
    await expect(
      listAzurePulls({ token, httpGet: http(403, null) }, target),
    ).rejects.toThrow('HTTP 403');
  });
});

describe('getAzurePull', () => {
  it('fetches and maps a single pull request', async () => {
    const pull = await getAzurePull(
      {
        token,
        httpGet: http(200, {
          pullRequestId: 9,
          sourceRefName: 'refs/heads/main',
        }),
      },
      target,
      9,
    );
    expect(pull).toMatchObject({
      number: 9,
      title: 'PR #9',
      sourceBranch: 'main',
      author: null,
    });
  });

  it('keeps a ref that is not under refs/heads/ as-is', async () => {
    const pull = await getAzurePull(
      {
        token,
        httpGet: http(200, { pullRequestId: 2, sourceRefName: 'topic/raw' }),
      },
      target,
      2,
    );
    expect(pull?.sourceBranch).toBe('topic/raw');
  });

  it('throws when not signed in', async () => {
    await expect(
      getAzurePull({ token: noToken, httpGet: http(200, {}) }, target, 1),
    ).rejects.toThrow('Not signed in');
  });

  it('returns null on a non-200 response', async () => {
    const pull = await getAzurePull(
      { token, httpGet: http(404, null) },
      target,
      1,
    );
    expect(pull).toBeNull();
  });
});
