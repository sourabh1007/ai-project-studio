import { describe, it, expect } from 'vitest';
import { listGithubRepos, parseGithubRepos } from './github-repo-lister.js';
import type { GhCommandResult } from '../github-auth/github-auth-service.js';

const ok = (stdout: string): GhCommandResult => ({ code: 0, stdout, stderr: '' });

describe('parseGithubRepos', () => {
  it('maps nameWithOwner/url/defaultBranch and appends .git', () => {
    const json = JSON.stringify([
      {
        nameWithOwner: 'acme/app',
        url: 'https://github.com/acme/app',
        defaultBranchRef: { name: 'main' },
      },
    ]);
    expect(parseGithubRepos(json)).toEqual([
      {
        provider: 'github',
        name: 'acme/app',
        remoteUrl: 'https://github.com/acme/app.git',
        defaultBranch: 'main',
      },
    ]);
  });

  it('keeps a url that already ends with .git and null default branch', () => {
    const json = JSON.stringify([
      {
        nameWithOwner: 'acme/lib',
        url: 'https://github.com/acme/lib.git',
        defaultBranchRef: null,
      },
    ]);
    expect(parseGithubRepos(json)).toEqual([
      {
        provider: 'github',
        name: 'acme/lib',
        remoteUrl: 'https://github.com/acme/lib.git',
        defaultBranch: null,
      },
    ]);
  });

  it('skips entries missing a name or url', () => {
    const json = JSON.stringify([
      { url: 'https://github.com/acme/x' },
      { nameWithOwner: 'acme/y' },
      { nameWithOwner: 'acme/z', url: 'https://github.com/acme/z' },
    ]);
    expect(parseGithubRepos(json).map((r) => r.name)).toEqual(['acme/z']);
  });

  it('returns [] for invalid JSON or a non-array payload', () => {
    expect(parseGithubRepos('not json')).toEqual([]);
    expect(parseGithubRepos('{"a":1}')).toEqual([]);
  });
});

describe('listGithubRepos', () => {
  it('runs gh repo list with the requested limit and json fields', async () => {
    let args: string[] = [];
    const repos = await listGithubRepos(
      async (a) => {
        args = a;
        return ok('[{"nameWithOwner":"a/b","url":"https://github.com/a/b"}]');
      },
      { limit: 25 },
    );
    expect(args).toEqual([
      'repo',
      'list',
      '--no-archived',
      '--limit',
      '25',
      '--json',
      'nameWithOwner,url,defaultBranchRef',
    ]);
    expect(repos.map((r) => r.name)).toEqual(['a/b']);
  });

  it('defaults the limit to 100', async () => {
    let args: string[] = [];
    await listGithubRepos(async (a) => {
      args = a;
      return ok('[]');
    });
    expect(args).toContain('100');
  });

  it('throws the stderr message when gh fails', async () => {
    await expect(
      listGithubRepos(async () => ({ code: 1, stdout: '', stderr: 'gh boom' })),
    ).rejects.toThrow('gh boom');
  });

  it('throws a default message when gh fails without stderr', async () => {
    await expect(
      listGithubRepos(async () => ({ code: 1, stdout: '', stderr: '' })),
    ).rejects.toThrow('Failed to list GitHub repositories');
  });

  it('throws an auth-required error when gh reports the user is not logged in', async () => {
    await expect(
      listGithubRepos(async () => ({
        code: 1,
        stdout: '',
        stderr:
          'To get started with GitHub CLI, please run:  gh auth login',
      })),
    ).rejects.toMatchObject({ kind: 'auth_required', provider: 'github' });
  });
});
