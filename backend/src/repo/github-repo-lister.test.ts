import { describe, it, expect } from 'vitest';
import { listGithubRepos, parseGithubRepos } from './github-repo-lister.js';
import type { GhCommandResult } from '../github-auth/github-auth-service.js';

const ok = (stdout: string): GhCommandResult => ({ code: 0, stdout, stderr: '' });

describe('parseGithubRepos', () => {
  it('maps full_name/clone_url/default_branch from the REST payload', () => {
    const json = JSON.stringify([
      {
        full_name: 'acme/app',
        clone_url: 'https://github.com/acme/app.git',
        default_branch: 'main',
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

  it('falls back to html_url (appending .git) and a null default branch', () => {
    const json = JSON.stringify([
      {
        full_name: 'acme/lib',
        html_url: 'https://github.com/acme/lib',
        default_branch: null,
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

  it('includes org and collaborator repos, skipping archived ones', () => {
    const json = JSON.stringify([
      {
        full_name: 'me/owned',
        clone_url: 'https://github.com/me/owned.git',
        default_branch: 'main',
      },
      {
        full_name: 'some-org/shared',
        clone_url: 'https://github.com/some-org/shared.git',
        default_branch: 'develop',
      },
      {
        full_name: 'me/old',
        clone_url: 'https://github.com/me/old.git',
        default_branch: 'main',
        archived: true,
      },
    ]);
    expect(parseGithubRepos(json).map((r) => r.name)).toEqual([
      'me/owned',
      'some-org/shared',
    ]);
  });

  it('skips entries missing a name or url', () => {
    const json = JSON.stringify([
      { clone_url: 'https://github.com/acme/x.git' },
      { full_name: 'acme/y' },
      { full_name: 'acme/z', clone_url: 'https://github.com/acme/z.git' },
    ]);
    expect(parseGithubRepos(json).map((r) => r.name)).toEqual(['acme/z']);
  });

  it('returns [] for invalid JSON or a non-array payload', () => {
    expect(parseGithubRepos('not json')).toEqual([]);
    expect(parseGithubRepos('{"a":1}')).toEqual([]);
  });
});

describe('listGithubRepos', () => {
  it('queries /user/repos for every affiliation, paginated', async () => {
    let args: string[] = [];
    const repos = await listGithubRepos(
      async (a) => {
        args = a;
        return ok(
          '[{"full_name":"a/b","clone_url":"https://github.com/a/b.git"}]',
        );
      },
      { perPage: 25 },
    );
    expect(args).toEqual([
      'api',
      '--paginate',
      'user/repos?per_page=25&affiliation=owner,collaborator,organization_member&sort=full_name',
    ]);
    expect(repos.map((r) => r.name)).toEqual(['a/b']);
  });

  it('defaults the page size to 100', async () => {
    let args: string[] = [];
    await listGithubRepos(async (a) => {
      args = a;
      return ok('[]');
    });
    expect(args.some((a) => a.includes('per_page=100'))).toBe(true);
  });

  it('throws a provider error with the stderr message when gh fails', async () => {
    await expect(
      listGithubRepos(async () => ({ code: 1, stdout: '', stderr: 'gh boom' })),
    ).rejects.toMatchObject({ kind: 'provider', message: 'gh boom' });
  });

  it('throws a friendly provider error when gh fails without stderr', async () => {
    await expect(
      listGithubRepos(async () => ({ code: 1, stdout: '', stderr: '' })),
    ).rejects.toMatchObject({
      kind: 'provider',
      message: 'Could not load GitHub repositories. Please try again.',
    });
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
