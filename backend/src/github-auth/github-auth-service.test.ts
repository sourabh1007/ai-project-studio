import { describe, it, expect } from 'vitest';
import {
  createGithubAuth,
  parseGhLogin,
  type GhCommandResult,
} from './github-auth-service.js';

function runner(map: Record<string, GhCommandResult>) {
  return (args: string[]) =>
    Promise.resolve(
      map[args.join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected' },
    );
}

describe('parseGhLogin', () => {
  it('extracts the account name from gh auth status output', () => {
    expect(
      parseGhLogin('✓ Logged in to github.com account sourabh1007 (keyring)'),
    ).toBe('sourabh1007');
  });

  it('returns null when no account is present', () => {
    expect(parseGhLogin('not logged in')).toBeNull();
  });
});

describe('createGithubAuth', () => {
  it('reports authenticated with the parsed login', async () => {
    const auth = createGithubAuth({
      run: runner({
        'auth status': {
          code: 0,
          stdout: '',
          stderr: 'Logged in to github.com account octocat (keyring)',
        },
      }),
    });
    expect(await auth.status()).toEqual({
      authenticated: true,
      login: 'octocat',
    });
  });

  it('reports not authenticated when gh exits non-zero', async () => {
    const auth = createGithubAuth({
      run: runner({ 'auth status': { code: 1, stdout: '', stderr: 'x' } }),
    });
    expect(await auth.status()).toEqual({
      authenticated: false,
      login: null,
    });
  });

  it('returns the trimmed token when present', async () => {
    const auth = createGithubAuth({
      run: runner({
        'auth token': { code: 0, stdout: 'gho_abc123\n', stderr: '' },
      }),
    });
    expect(await auth.token()).toBe('gho_abc123');
  });

  it('returns null when the token command fails or is empty', async () => {
    const fail = createGithubAuth({
      run: runner({ 'auth token': { code: 1, stdout: '', stderr: 'no' } }),
    });
    expect(await fail.token()).toBeNull();

    const empty = createGithubAuth({
      run: runner({ 'auth token': { code: 0, stdout: '   \n', stderr: '' } }),
    });
    expect(await empty.token()).toBeNull();
  });
});
