import { describe, it, expect, vi } from 'vitest';
import {
  favouriteAzureBranch,
  favoritesUrl,
  repositoryUrl,
  toBranchRef,
  type AzureBranchFavoriteDeps,
} from './azure-branch-favorites.js';

const REMOTE = 'https://dev.azure.com/org/project/_git/repo';

function makeDeps(over: {
  token?: string | null;
  get?: { status: number; body: unknown };
  post?: { status: number; body: unknown };
}): {
  deps: AzureBranchFavoriteDeps;
  httpGet: ReturnType<typeof vi.fn>;
  httpPost: ReturnType<typeof vi.fn>;
} {
  const httpGet = vi.fn(async () => over.get ?? { status: 200, body: { id: 'guid-1' } });
  const httpPost = vi.fn(async () => over.post ?? { status: 200, body: {} });
  return {
    deps: {
      token: vi.fn(async () => (over.token === undefined ? 'tok' : over.token)),
      httpGet,
      httpPost,
    },
    httpGet,
    httpPost,
  };
}

describe('toBranchRef', () => {
  it('prefixes a bare branch name with refs/heads/', () => {
    expect(toBranchRef('feature/x')).toBe('refs/heads/feature/x');
  });

  it('leaves an explicit refs/ path untouched', () => {
    expect(toBranchRef('refs/heads/main')).toBe('refs/heads/main');
  });
});

describe('url builders', () => {
  it('encodes org/project/repo in the repository URL', () => {
    expect(repositoryUrl('o r', 'p', 'r')).toBe(
      'https://dev.azure.com/o%20r/p/_apis/git/repositories/r?api-version=7.1',
    );
  });

  it('builds the git ref favourites URL', () => {
    expect(favoritesUrl('org', 'proj')).toBe(
      'https://dev.azure.com/org/proj/_apis/git/favorites/refs?api-version=7.1',
    );
  });
});

describe('favouriteAzureBranch', () => {
  it('skips a non-Azure remote', async () => {
    const { deps } = makeDeps({});
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: 'not a url',
      branch: 'b',
    });
    expect(result.status).toBe('skipped');
  });

  it('skips an empty branch', async () => {
    const { deps } = makeDeps({});
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: '   ',
    });
    expect(result.status).toBe('skipped');
  });

  it('skips when not signed in', async () => {
    const { deps } = makeDeps({ token: null });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'b',
    });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('org');
  });

  it('fails when the repository lookup errors', async () => {
    const { deps } = makeDeps({ get: { status: 500, body: null } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'b',
    });
    expect(result.status).toBe('failed');
  });

  it('fails when the repository lookup returns a below-range status', async () => {
    const { deps } = makeDeps({ get: { status: 100, body: { id: 'x' } } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'b',
    });
    expect(result.status).toBe('failed');
  });

  it('fails when the repository id is missing', async () => {
    const { deps } = makeDeps({ get: { status: 200, body: {} } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'b',
    });
    expect(result.status).toBe('failed');
  });

  it('fails when the repository id is empty', async () => {
    const { deps } = makeDeps({ get: { status: 200, body: { id: '' } } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'b',
    });
    expect(result.status).toBe('failed');
  });

  it('reports an already-favourited branch (409) as success', async () => {
    const { deps } = makeDeps({ post: { status: 409, body: {} } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'feature/x',
    });
    expect(result.status).toBe('already');
  });

  it('favourites the branch with the resolved repository id', async () => {
    const { deps, httpPost } = makeDeps({
      get: { status: 200, body: { id: 'guid-99' } },
      post: { status: 201, body: {} },
    });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'feature/x',
    });
    expect(result.status).toBe('favourited');
    expect(httpPost).toHaveBeenCalledWith(
      favoritesUrl('org', 'project'),
      'tok',
      { name: 'refs/heads/feature/x', repositoryId: 'guid-99', type: 'ref' },
    );
  });

  it('fails on any other favourite error status', async () => {
    const { deps } = makeDeps({ post: { status: 403, body: {} } });
    const result = await favouriteAzureBranch(deps, {
      remoteUrl: REMOTE,
      branch: 'feature/x',
    });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('403');
  });
});
