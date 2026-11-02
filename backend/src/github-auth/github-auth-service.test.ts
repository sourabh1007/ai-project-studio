import { describe, it, expect } from 'vitest';
import {
  createGithubAuth,
  parseGhLogin,
  type GhCommandResult,
} from './github-auth-service.js';

function runner(map: Record<string, GhCommandResult>) {
  return (args: string[]) =>
    Promise.resolve(
      map[args.slice(0, 2).join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected' },
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
  it('reads the public GitHub account and token explicitly rather than an inherited enterprise default host', async () => {
    const calls: string[][] = [];
    const auth = createGithubAuth({
      run: async (args) => {
        calls.push(args);
        const publicHost = args.includes('github.com');
        return args[1] === 'status'
          ? { code: 0, stdout: `Logged in to ${publicHost ? 'github.com account public-user' : 'enterprise.example account other-user'}`, stderr: '' }
          : { code: 0, stdout: publicHost ? 'public-token' : 'wrong-host-token', stderr: '' };
      },
    });
    expect(await auth.status()).toEqual({ authenticated: true, login: 'public-user' });
    expect(await auth.token()).toBe('public-token');
    expect(calls).toEqual([
      ['auth', 'status', '--hostname', 'github.com'],
      ['auth', 'token', '--hostname', 'github.com'],
    ]);
  });

  it.each([
    [{ code: 0, stdout: ' cached\n', stderr: '' }, { state: 'ready', token: 'cached' }],
    [{ code: 0, stdout: '', stderr: '' }, { state: 'signed-out' }],
    [{ code: 1, stdout: '', stderr: 'no oauth token found for github.com' }, { state: 'signed-out' }],
    [{ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts' }, { state: 'signed-out' }],
    [{ code: 1, stdout: '', stderr: 'keyring unavailable' }, { state: 'unavailable' }],
  ])('distinguishes stored-token availability without treating failures as logout: %j', async (result, expected) => {
    const auth = createGithubAuth({ run: async () => result });
    expect(await auth.readToken()).toEqual(expected);
  });
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
        'auth token': { code: 1, stdout: '', stderr: 'no oauth token found for github.com' },
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

  it('reports an unavailable keyring instead of incorrectly returning a signed-out account', async () => {
    const auth = createGithubAuth({
      run: runner({
        'auth status': { code: 1, stdout: '', stderr: 'could not connect' },
        'auth token': { code: 1, stdout: '', stderr: 'keyring unavailable' },
      }),
    });
    await expect(auth.status()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reports signed out when the native token lookup succeeds with no stored credential', async () => {
    const auth = createGithubAuth({
      run: runner({
        'auth status': { code: 1, stdout: '', stderr: 'not logged in' },
        'auth token': { code: 0, stdout: '', stderr: '' },
      }),
    });
    expect(await auth.status()).toEqual({ authenticated: false, login: null });
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
        if (args.join(' ') === 'auth status --hostname github.com') {
          return Promise.resolve({ code: 1, stdout: '', stderr: 'not logged in' });
        }
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    expect(await auth.signOut()).toEqual({ authenticated: false, login: null });
    expect(calls).toContainEqual(['auth', 'logout', '--hostname', 'github.com']);
    expect(calls).toContainEqual(['auth', 'status', '--hostname', 'github.com']);
  });
});
