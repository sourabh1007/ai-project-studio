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
      run: runner({
        'auth status': { code: 1, stdout: '', stderr: 'x' },
        'auth token': { code: 1, stdout: '', stderr: 'no token' },
      }),
    });
    expect(await auth.status()).toEqual({
      authenticated: false,
      login: null,
    });
  });

  it('stays signed in when validation fails transiently but a token is stored', async () => {
    // `gh auth status` fails during a GitHub outage, yet the credential is
    // still in the keyring — the badge must not flip to "sign in required".
    const auth = createGithubAuth({
      run: runner({
        'auth status': {
          code: 1,
          stdout: '',
          stderr:
            'Logged in to github.com account octocat (keyring)\n  X Failed to validate token: GitHub returned 503',
        },
        'auth token': { code: 0, stdout: 'gho_stored\n', stderr: '' },
      }),
    });
    expect(await auth.status()).toEqual({
      authenticated: true,
      login: 'octocat',
    });
  });

  it('reports signed in without a login when the token is stored but status is bare', async () => {
    const auth = createGithubAuth({
      run: runner({
        'auth status': { code: 1, stdout: '', stderr: 'could not connect' },
        'auth token': { code: 0, stdout: 'gho_stored\n', stderr: '' },
      }),
    });
    expect(await auth.status()).toEqual({
      authenticated: true,
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

  it('signs out via gh auth logout and reports the resulting status', async () => {
    const calls: string[][] = [];
    const auth = createGithubAuth({
      run: (args: string[]) => {
        calls.push(args);
        if (args.join(' ') === 'auth status') {
          return Promise.resolve({ code: 1, stdout: '', stderr: 'not logged in' });
        }
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    expect(await auth.signOut()).toEqual({ authenticated: false, login: null });
    expect(calls).toContainEqual(['auth', 'logout', '--hostname', 'github.com']);
    expect(calls).toContainEqual(['auth', 'status']);
  });
});
