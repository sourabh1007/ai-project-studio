import { describe, it, expect } from 'vitest';
import {
  buildCredentialQuery,
  createAzureDevOpsAuth,
  describeAzureFailure,
  parseAzureTarget,
  parseCredentialOutput,
  parseCredentialPassword,
  type GitRunResult,
} from './azure-devops-auth.js';

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'no cred'): GitRunResult => ({
  code: 1,
  stdout: '',
  stderr,
});

describe('parseAzureTarget', () => {
  it('defaults to account-level dev.azure.com for empty input', () => {
    expect(parseAzureTarget(null)).toEqual({ host: 'dev.azure.com', org: null });
    expect(parseAzureTarget('   ')).toEqual({
      host: 'dev.azure.com',
      org: null,
    });
  });

  it('treats a bare word as an org on dev.azure.com', () => {
    expect(parseAzureTarget('contoso')).toEqual({
      host: 'dev.azure.com',
      org: 'contoso',
    });
  });

  it('parses a dev.azure.com remote URL', () => {
    expect(
      parseAzureTarget('https://dev.azure.com/contoso/Project/_git/repo'),
    ).toEqual({ host: 'dev.azure.com', org: 'contoso' });
  });

  it('parses a host-only dev.azure.com value without an org', () => {
    expect(parseAzureTarget('dev.azure.com')).toEqual({
      host: 'dev.azure.com',
      org: null,
    });
  });

  it('parses an ssh dev.azure.com host', () => {
    expect(
      parseAzureTarget('https://ssh.dev.azure.com/contoso/proj'),
    ).toEqual({ host: 'dev.azure.com', org: 'contoso' });
  });

  it.each([
    'git@ssh.dev.azure.com:v3/contoso/project/repo',
    'ssh://git@ssh.dev.azure.com/v3/contoso/project/repo',
  ])('uses the real organization from an Azure SSH remote: %s', (remote) => {
    expect(parseAzureTarget(remote)).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(buildCredentialQuery(parseAzureTarget(remote))).toBe('protocol=https\nhost=dev.azure.com\npath=contoso\n\n');
  });

  it('does not mistake the SSH v3 prefix for an organization when the path is incomplete', () => {
    expect(parseAzureTarget('ssh://git@ssh.dev.azure.com/v3/')).toEqual({ host: 'dev.azure.com', org: null });
  });

  it('parses a legacy visualstudio.com URL, taking the org from the host', () => {
    expect(
      parseAzureTarget('https://contoso.visualstudio.com/_git/repo'),
    ).toEqual({ host: 'contoso.visualstudio.com', org: 'contoso' });
  });

  it('parses a bare visualstudio.com host', () => {
    expect(parseAzureTarget('contoso.visualstudio.com')).toEqual({
      host: 'contoso.visualstudio.com',
      org: 'contoso',
    });
  });

  it('parses an on-prem host, taking the collection as the org', () => {
    expect(
      parseAzureTarget('https://tfs.internal:8080/DefaultCollection/_git/x'),
    ).toEqual({ host: 'tfs.internal', org: 'DefaultCollection' });
  });

  it('parses an on-prem host with no collection path as a null org', () => {
    expect(parseAzureTarget('https://tfs.internal:8080')).toEqual({
      host: 'tfs.internal',
      org: null,
    });
  });

  it('falls back to org-on-dev when a URL-shaped value fails to parse', () => {
    expect(parseAzureTarget('http://')).toEqual({
      host: 'dev.azure.com',
      org: 'http://',
    });
  });

  it('handles a visualstudio host with no org label', () => {
    expect(parseAzureTarget('https://.visualstudio.com/x')).toEqual({
      host: '.visualstudio.com',
      org: null,
    });
  });
});

describe('buildCredentialQuery', () => {
  it('includes path for a dev.azure.com org', () => {
    expect(
      buildCredentialQuery({ host: 'dev.azure.com', org: 'contoso' }),
    ).toBe('protocol=https\nhost=dev.azure.com\npath=contoso\n\n');
  });

  it('omits path when there is no org', () => {
    expect(buildCredentialQuery({ host: 'dev.azure.com', org: null })).toBe(
      'protocol=https\nhost=dev.azure.com\n\n',
    );
  });

  it('omits path for visualstudio.com where the org is in the host', () => {
    expect(
      buildCredentialQuery({ host: 'contoso.visualstudio.com', org: 'contoso' }),
    ).toBe('protocol=https\nhost=contoso.visualstudio.com\n\n');
  });
});

describe('parseCredentialOutput', () => {
  it('reports authenticated with the account when a password is present', () => {
    expect(
      parseCredentialOutput(
        'protocol=https\nhost=dev.azure.com\nusername=alice@contoso.com\npassword=token123\n',
      ),
    ).toEqual({
      authenticated: true,
      account: 'alice@contoso.com',
      message: null,
    });
  });

  it('reports authenticated with null account when username is absent', () => {
    expect(parseCredentialOutput('password=token123')).toEqual({
      authenticated: true,
      account: null,
      message: null,
    });
  });

  it('reports unauthenticated when there is no password', () => {
    expect(parseCredentialOutput('username=alice\n\nnoequalshere')).toEqual({
      authenticated: false,
      account: null,
      message: null,
    });
  });

  it('reports unauthenticated for an empty password value', () => {
    expect(parseCredentialOutput('password=')).toEqual({
      authenticated: false,
      account: null,
      message: null,
    });
  });
});

describe('parseCredentialPassword', () => {
  it('returns the token when a password is present', () => {
    expect(
      parseCredentialPassword('username=alice\npassword=token123\n'),
    ).toBe('token123');
  });

  it('returns null for an empty password value', () => {
    expect(parseCredentialPassword('password=')).toBeNull();
  });

  it('returns null when no password line is present', () => {
    expect(parseCredentialPassword('username=alice\nnoequals')).toBeNull();
  });
});

describe('describeAzureFailure', () => {
  it('detects a missing Git Credential Manager', () => {
    expect(
      describeAzureFailure("'git-credential-manager' is not recognized"),
    ).toMatch(/not installed/);
    expect(describeAzureFailure('spawn ENOENT')).toMatch(/not installed/);
  });

  it('detects a cancelled sign-in', () => {
    expect(describeAzureFailure('The user canceled authentication')).toMatch(
      /cancelled/,
    );
  });

  it('detects an access / permission failure', () => {
    expect(describeAzureFailure('AADSTS50020: no access')).toMatch(
      /does not have access/,
    );
    expect(describeAzureFailure('HTTP 403 Forbidden')).toMatch(
      /does not have access/,
    );
  });

  it('falls back to a generic message when stderr is empty', () => {
    expect(describeAzureFailure('   ')).toMatch(/did not complete/);
  });

  it('surfaces the first line of an unrecognized error', () => {
    expect(describeAzureFailure('weird failure\nstack line 2')).toBe(
      'Azure DevOps sign-in failed: weird failure',
    );
  });
});

describe('createAzureDevOpsAuth', () => {
  it('configure enables OAuth credentials and disables the WAM broker', async () => {
    const calls: string[][] = [];
    const auth = createAzureDevOpsAuth({
      credential: async () => ok(''),
      config: async (args) => {
        calls.push(args);
        return ok('');
      },
    });

    await auth.configure();

    expect(calls).toEqual([
      ['config', '--global', 'credential.azreposCredentialType', 'oauth'],
      ['config', '--global', 'credential.msauthUseBroker', 'false'],
    ]);
  });

  it('status runs a non-interactive credential get and parses the result', async () => {
    let seen: { verb: string; input: string; interactive: boolean } | null =
      null;
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb, input, opts) => {
        seen = { verb, input, interactive: opts.interactive };
        return ok('username=alice\npassword=tok');
      },
    });

    const result = await auth.status({ host: 'dev.azure.com', org: 'contoso' });

    expect(seen).toEqual({
      verb: 'get',
      input: 'protocol=https\nhost=dev.azure.com\npath=contoso\n\n',
      interactive: false,
    });
    expect(result).toEqual({
      authenticated: true,
      account: 'alice',
      message: null,
    });
  });

  it('signIn runs an interactive credential get', async () => {
    const calls: Array<{ verb: string; interactive: boolean }> = [];
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb, _input, opts) => {
        calls.push({ verb, interactive: opts.interactive });
        return ok('username=bob\npassword=tok');
      },
    });

    const result = await auth.signIn({ host: 'dev.azure.com', org: null });

    expect(calls).toEqual([
      { verb: 'get', interactive: true },
      { verb: 'store', interactive: false },
      { verb: 'get', interactive: false },
    ]);
    expect(result).toEqual({ authenticated: true, account: 'bob', message: null });
  });

  it.each([
    { host: 'dev.azure.com', org: 'fabrikam' },
    { host: 'fabrikam.visualstudio.com', org: 'fabrikam' },
  ])('remembers the organization binding across repeated checks and facade restarts: %j', async (target) => {
    const first = { host: 'dev.azure.com', org: 'contoso' };
    const bindings = new Map([[buildCredentialQuery(first), 'alice']]);
    const calls: Array<{ verb: string; input: string }> = [];
    const deps: Parameters<typeof createAzureDevOpsAuth>[0] = {
      config: async () => ok(''),
      credential: async (verb, input, opts) => {
        calls.push({ verb, input });
        if (verb === 'store') {
          expect(opts.interactive).toBe(false);
          expect(input).toBe(`${buildCredentialQuery(target).trimEnd()}\nusername=alice\npassword=fixture-token\n\n`);
          bindings.set(buildCredentialQuery(target), 'alice');
          return ok('');
        }
        if (opts.interactive || bindings.has(input)) {
          return ok('protocol=https\r\nhost=ignored.example\r\nusername=alice\r\npassword=fixture-token\r\ncapability=fixture\r\n');
        }
        return fail('fatal: Cannot prompt because user interactivity has been disabled.');
      },
    };
    const auth = createAzureDevOpsAuth(deps);
    expect((await auth.status(target)).authenticated).toBe(false);
    expect((await auth.signIn(target)).authenticated).toBe(true);
    expect((await auth.status(first)).authenticated).toBe(true);
    expect((await auth.status(target)).authenticated).toBe(true);
    expect((await createAzureDevOpsAuth(deps).status(target)).authenticated).toBe(true);
    expect(calls.filter(({ verb }) => verb === 'store')).toHaveLength(1);
    expect(calls.some(({ verb }) => verb === 'erase')).toBe(false);
  });

  it('does not report successful sign-in when saving the native organization binding fails', async () => {
    const calls: string[] = [];
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb) => {
        calls.push(verb);
        return verb === 'store' ? fail('configuration is read-only') : ok('username=alice\npassword=fixture-token');
      },
    });
    expect(await auth.signIn({ host: 'dev.azure.com', org: 'contoso' })).toEqual({
      authenticated: false, account: null,
      message: 'Could not remember Azure DevOps sign-in for this organization. Azure DevOps sign-in failed: configuration is read-only',
    });
    expect(calls).toEqual(['get', 'store']);
  });

  it('does not claim persistent sign-in if the silent confirmation still requires interaction', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb, _input, opts) => opts.interactive
        ? ok('username=alice\npassword=fixture-token')
        : verb === 'store' ? ok('') : fail('fatal: Cannot prompt because user interactivity has been disabled.'),
    });
    expect(await auth.signIn({ host: 'dev.azure.com', org: 'contoso' })).toEqual({
      authenticated: false, account: null,
      message: 'The saved Azure DevOps account could not be reused silently. Please try signing in again.',
    });
  });

  it('does not store credentials when interactive sign-in returns no credential', async () => {
    const calls: string[] = [];
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb) => { calls.push(verb); return ok(''); },
    });
    expect((await auth.signIn({ host: 'dev.azure.com', org: 'contoso' })).authenticated).toBe(false);
    expect(calls).toEqual(['get']);
  });

  it('signIn surfaces a reason when the interactive get fails', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail('fatal: AADSTS50020 no access'),
    });

    const result = await auth.signIn({ host: 'dev.azure.com', org: 'contoso' });

    expect(result.authenticated).toBe(false);
    expect(result.message).toMatch(/does not have access/);
  });

  it('signOut erases both the org-scoped and account-level credentials', async () => {
    const seen: { verb: string; input: string; interactive: boolean }[] = [];
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (verb, input, opts) => {
        seen.push({ verb, input, interactive: opts.interactive });
        return ok('');
      },
    });

    const result = await auth.signOut({ host: 'dev.azure.com', org: 'contoso' });

    expect(seen).toEqual([
      {
        verb: 'erase',
        input: 'protocol=https\nhost=dev.azure.com\npath=contoso\n\n',
        interactive: false,
      },
      {
        verb: 'erase',
        input: 'protocol=https\nhost=dev.azure.com\n\n',
        interactive: false,
      },
    ]);
    expect(result).toEqual({
      authenticated: false,
      account: null,
      message: null,
    });
  });

  it('signOut erases only the account-level credential when no org is given', async () => {
    const seen: string[] = [];
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (_verb, input) => {
        seen.push(input);
        return ok('');
      },
    });

    const result = await auth.signOut({ host: 'dev.azure.com', org: null });

    expect(seen).toEqual(['protocol=https\nhost=dev.azure.com\n\n']);
    expect(result.authenticated).toBe(false);
    expect(result.message).toBeNull();
  });

  it('signOut surfaces a reason when the erase fails', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail('git-credential-manager is not recognized'),
    });

    const result = await auth.signOut({ host: 'dev.azure.com', org: null });

    expect(result.authenticated).toBe(false);
    expect(result.message).toMatch(/not installed/);
  });

  it('signOut reports the first failure reason when every erase fails', async () => {
    const messages = [
      'git-credential-manager is not recognized',
      'some later unrelated error',
    ];
    let i = 0;
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail(messages[i++] ?? ''),
    });

    const result = await auth.signOut({ host: 'dev.azure.com', org: 'contoso' });

    expect(i).toBe(2);
    expect(result.message).toMatch(/not installed/);
  });

  it('reports unauthenticated when the native credential helper requires sign-in', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail('fatal: Cannot prompt because user interactivity has been disabled.'),
    });

    expect(
      await auth.status({ host: 'dev.azure.com', org: null }),
    ).toEqual({ authenticated: false, account: null, message: null });
  });

  it.each([fail('keyring unavailable'), fail('network timeout'), ok('quit=1\n')])(
    'does not turn an unavailable native status check into a confirmed logout: %j',
    async (result) => {
      const auth = createAzureDevOpsAuth({ config: async () => ok(''), credential: async () => result });
      await expect(auth.status({ host: 'dev.azure.com', org: null })).rejects.toMatchObject({ kind: 'unavailable' });
    },
  );

  it('reports signed out when a silent credential check confirms no stored credential', async () => {
    const auth = createAzureDevOpsAuth({ config: async () => ok(''), credential: async () => ok('') });
    expect(await auth.status({ host: 'dev.azure.com', org: null })).toEqual({
      authenticated: false, account: null, message: null,
    });
  });

  it('token returns the cached OAuth password from a non-interactive get', async () => {
    let interactive = true;
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (_verb, _input, opts) => {
        interactive = opts.interactive;
        return ok('username=alice\npassword=bearer-tok');
      },
    });

    const token = await auth.token({ host: 'dev.azure.com', org: 'contoso' });

    expect(interactive).toBe(false);
    expect(token).toBe('bearer-tok');
  });

  it('token returns null when the credential runner fails', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail(),
    });

    expect(await auth.token({ host: 'dev.azure.com', org: 'x' })).toBeNull();
  });

  it.each([
    [ok('username=fixture\npassword=stored'), { state: 'ready', token: 'stored' }],
    [ok(''), { state: 'signed-out' }],
    [fail(), { state: 'unavailable' }],
    [{ code: 1, stdout: '', stderr: 'fatal: Cannot prompt because user interactivity has been disabled.\n' }, { state: 'interaction-required' }],
    [{ code: 1, stdout: '', stderr: 'Cannot prompt because terminal prompts have been disabled.' }, { state: 'interaction-required' }],
    [{ code: 1, stdout: '', stderr: 'Network failed; diagnostic context: Cannot prompt because user interactivity has been disabled.' }, { state: 'unavailable' }],
    [ok('quit=1\n\n'), { state: 'unavailable' }],
    [ok('quit=true\r\n'), { state: 'unavailable' }],
  ])('distinguishes a missing cached credential from an unavailable credential helper: %j', async (result, expected) => {
    const auth = createAzureDevOpsAuth({ config: async () => ok(''), credential: async () => result });
    expect(await auth.readToken({ host: 'dev.azure.com', org: 'fixture' })).toEqual(expected);
  });
});
