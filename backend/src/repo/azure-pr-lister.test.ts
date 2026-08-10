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
  connectionDataUrl,
  parseAuthenticatedUser,
  profileUrl,
  parseProfileUser,
  fetchAzureUser,
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

function captureHttp(
  status: number,
  body: unknown,
  urls: string[],
): AzureHttpGetter {
  return (url: string) => {
    urls.push(url);
    return Promise.resolve({ status, body });
  };
}

const pullBody = {
  value: [
    {
      pullRequestId: 42,
      title: 'Add feature',
      sourceRefName: 'refs/heads/topic/x',
      targetRefName: 'refs/heads/main',
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
      'https://dev.azure.com/myorg/myproject/_apis/git/repositories/myrepo/pullrequests?searchCriteria.status=active&$top=1000&api-version=7.1',
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
        targetBranch: 'main',
        author: 'Ada',
        isAuthor: false,
        isReviewer: false,
      },
    ]);
  });

  it('flags the current user as author or reviewer by id or email', async () => {
    const body = {
      value: [
        {
          pullRequestId: 1,
          sourceRefName: 'refs/heads/a',
          createdBy: { id: 'u1', displayName: 'Ada' },
        },
        {
          pullRequestId: 2,
          sourceRefName: 'refs/heads/b',
          createdBy: { id: 'other', uniqueName: 'Me@Example.com', displayName: 'Bo' },
          reviewers: [{ id: 'u1' }],
        },
        {
          pullRequestId: 3,
          sourceRefName: 'refs/heads/c',
          createdBy: { id: 'x', uniqueName: 'me@example.com' },
        },
      ],
    };
    const pulls = await listAzurePulls(
      { token, httpGet: http(200, body) },
      target,
      { currentUser: { id: 'u1', uniqueName: 'me@example.com' } },
    );
    // matched by id
    expect(pulls[0]).toMatchObject({ isAuthor: true, isReviewer: false });
    // author by email (case-insensitive), reviewer by id
    expect(pulls[1]).toMatchObject({ isAuthor: true, isReviewer: true });
    // author by email only
    expect(pulls[2]).toMatchObject({ isAuthor: true, isReviewer: false });
  });

  it('does not flag PRs when the identity does not match', async () => {
    const body = {
      value: [
        {
          pullRequestId: 1,
          sourceRefName: 'refs/heads/a',
          createdBy: { id: 'someone', uniqueName: 'other@example.com' },
          reviewers: [{ id: 'nope' }],
        },
        {
          // no createdBy / reviewers at all
          pullRequestId: 2,
          sourceRefName: 'refs/heads/z',
        },
      ],
    };
    const pulls = await listAzurePulls(
      { token, httpGet: http(200, body) },
      target,
      { currentUser: { id: 'u1', uniqueName: 'me@example.com' } },
    );
    expect(pulls[0]).toMatchObject({ isAuthor: false, isReviewer: false });
    expect(pulls[1]).toMatchObject({ isAuthor: false, isReviewer: false });
  });

  it('returns an empty array when the body has no value array', async () => {
    const pulls = await listAzurePulls(
      { token, httpGet: http(200, {}) },
      target,
    );
    expect(pulls).toEqual([]);
  });

  it('filters to the current user\'s own PRs server-side for "mine"', async () => {
    const urls: string[] = [];
    const body = {
      value: [
        {
          pullRequestId: 1,
          sourceRefName: 'refs/heads/a',
          createdBy: { id: 'u1', displayName: 'Ada' },
        },
        {
          pullRequestId: 2,
          sourceRefName: 'refs/heads/b',
          createdBy: { id: 'other', displayName: 'Bo' },
        },
      ],
    };
    const pulls = await listAzurePulls(
      { token, httpGet: captureHttp(200, body, urls) },
      target,
      { currentUser: { id: 'u1', uniqueName: null }, filter: 'mine' },
    );
    expect(urls[0]).toContain('searchCriteria.creatorId=u1');
    expect(pulls.map((p) => p.number)).toEqual([1]);
  });

  it('filters to PRs awaiting the current user\'s review for "assigned"', async () => {
    const urls: string[] = [];
    const body = {
      value: [
        {
          pullRequestId: 1,
          sourceRefName: 'refs/heads/a',
          createdBy: { id: 'x' },
          reviewers: [{ id: 'u1' }],
        },
        {
          pullRequestId: 2,
          sourceRefName: 'refs/heads/b',
          createdBy: { id: 'x' },
          reviewers: [{ id: 'nope' }],
        },
      ],
    };
    const pulls = await listAzurePulls(
      { token, httpGet: captureHttp(200, body, urls) },
      target,
      { currentUser: { id: 'u1', uniqueName: null }, filter: 'assigned' },
    );
    expect(urls[0]).toContain('searchCriteria.reviewerId=u1');
    expect(pulls.map((p) => p.number)).toEqual([1]);
  });

  it('omits server-side id params when only the email is known', async () => {
    const urls: string[] = [];
    const body = {
      value: [
        {
          pullRequestId: 1,
          sourceRefName: 'refs/heads/a',
          createdBy: { uniqueName: 'me@example.com' },
        },
      ],
    };
    const pulls = await listAzurePulls(
      { token, httpGet: captureHttp(200, body, urls) },
      target,
      { currentUser: { id: null, uniqueName: 'me@example.com' }, filter: 'mine' },
    );
    expect(urls[0]).not.toContain('creatorId');
    expect(pulls.map((p) => p.number)).toEqual([1]);
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

describe('connection data', () => {
  it('builds the connectionData URL', () => {
    expect(connectionDataUrl('myorg')).toBe(
      'https://dev.azure.com/myorg/_apis/connectionData?api-version=7.1',
    );
  });

  it('parses the authenticated user id and unique name', () => {
    expect(
      parseAuthenticatedUser({
        authenticatedUser: { id: 'u1', uniqueName: 'a@b.com' },
      }),
    ).toEqual({ id: 'u1', uniqueName: 'a@b.com' });
  });

  it('falls back to the Account property for the unique name', () => {
    expect(
      parseAuthenticatedUser({
        authenticatedUser: {
          id: 'u2',
          properties: { Account: { $value: 'acc@b.com' } },
        },
      }),
    ).toEqual({ id: 'u2', uniqueName: 'acc@b.com' });
  });

  it('yields a null unique name when no account info is present', () => {
    expect(parseAuthenticatedUser({ authenticatedUser: { id: 'u3' } })).toEqual(
      { id: 'u3', uniqueName: null },
    );
    expect(
      parseAuthenticatedUser({ authenticatedUser: { properties: {} } }),
    ).toEqual({ id: null, uniqueName: null });
  });

  it('returns nulls for a missing or malformed payload', () => {
    expect(parseAuthenticatedUser(null)).toEqual({ id: null, uniqueName: null });
    expect(parseAuthenticatedUser({})).toEqual({ id: null, uniqueName: null });
    expect(
      parseAuthenticatedUser({
        authenticatedUser: { id: '', properties: { Account: { $value: 5 } } },
      }),
    ).toEqual({ id: null, uniqueName: null });
  });

  it('fetches the current user via the profile API', async () => {
    const routed: AzureHttpGetter = (url) =>
      Promise.resolve(
        url.includes('/profile/profiles/me')
          ? {
              status: 200,
              body: { id: 'p1', emailAddress: 'me@example.com' },
            }
          : { status: 200, body: { authenticatedUser: { id: 'should-not' } } },
      );
    const user = await fetchAzureUser({ token, httpGet: routed }, 'myorg');
    expect(user).toEqual({ id: 'p1', uniqueName: 'me@example.com' });
  });

  it('falls back to connectionData when the profile API is unavailable', async () => {
    const routed: AzureHttpGetter = (url) =>
      Promise.resolve(
        url.includes('/profile/profiles/me')
          ? { status: 400, body: null }
          : { status: 200, body: { authenticatedUser: { id: 'u9' } } },
      );
    const user = await fetchAzureUser({ token, httpGet: routed }, 'myorg');
    expect(user).toEqual({ id: 'u9', uniqueName: null });
  });

  it('falls back when the profile API returns no id or email', async () => {
    const routed: AzureHttpGetter = (url) =>
      Promise.resolve(
        url.includes('/profile/profiles/me')
          ? { status: 200, body: {} }
          : { status: 200, body: { authenticatedUser: { id: 'u9' } } },
      );
    const user = await fetchAzureUser({ token, httpGet: routed }, 'myorg');
    expect(user).toEqual({ id: 'u9', uniqueName: null });
  });

  it('builds the profile URL', () => {
    expect(profileUrl()).toBe(
      'https://vssps.dev.azure.com/_apis/profile/profiles/me?api-version=7.1',
    );
  });

  it('parses the profile id and email', () => {
    expect(
      parseProfileUser({ id: 'p1', emailAddress: 'me@example.com' }),
    ).toEqual({ id: 'p1', uniqueName: 'me@example.com' });
  });

  it('yields nulls for an empty or malformed profile', () => {
    expect(parseProfileUser({})).toEqual({ id: null, uniqueName: null });
    expect(parseProfileUser(null)).toEqual({ id: null, uniqueName: null });
    expect(parseProfileUser({ id: '', emailAddress: 5 })).toEqual({
      id: null,
      uniqueName: null,
    });
  });

  it('returns null when not signed in', async () => {
    const user = await fetchAzureUser(
      { token: noToken, httpGet: http(200, {}) },
      'myorg',
    );
    expect(user).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    const user = await fetchAzureUser(
      { token, httpGet: http(500, null) },
      'myorg',
    );
    expect(user).toBeNull();
  });

  it('returns null when the user has no identifiable id or email', async () => {
    const user = await fetchAzureUser(
      { token, httpGet: http(200, { authenticatedUser: {} }) },
      'myorg',
    );
    expect(user).toBeNull();
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
          targetRefName: 'refs/heads/release/1.0',
        }),
      },
      target,
      9,
    );
    expect(pull).toMatchObject({
      number: 9,
      title: 'PR #9',
      sourceBranch: 'main',
      targetBranch: 'release/1.0',
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

  it('keeps a non-empty description and nulls a whitespace-only one', async () => {
    const withBody = await getAzurePull(
      {
        token,
        httpGet: http(200, {
          pullRequestId: 3,
          sourceRefName: 'refs/heads/main',
          description: 'Implements the feature',
        }),
      },
      target,
      3,
    );
    expect(withBody?.body).toBe('Implements the feature');

    const blankBody = await getAzurePull(
      {
        token,
        httpGet: http(200, {
          pullRequestId: 4,
          sourceRefName: 'refs/heads/main',
          description: '   ',
        }),
      },
      target,
      4,
    );
    expect(blankBody?.body).toBeNull();
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
