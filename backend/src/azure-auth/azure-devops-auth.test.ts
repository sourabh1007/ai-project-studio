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
    let interactive = false;
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async (_verb, _input, opts) => {
        interactive = opts.interactive;
        return ok('username=bob\npassword=tok');
      },
    });

    const result = await auth.signIn({ host: 'dev.azure.com', org: null });

    expect(interactive).toBe(true);
    expect(result).toEqual({ authenticated: true, account: 'bob', message: null });
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

  it('signOut erases the cached credential and reports signed out', async () => {
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
    ]);
    expect(result).toEqual({
      authenticated: false,
      account: null,
      message: null,
    });
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

  it('reports unauthenticated when the credential runner fails', async () => {
    const auth = createAzureDevOpsAuth({
      config: async () => ok(''),
      credential: async () => fail(),
    });

    expect(
      await auth.status({ host: 'dev.azure.com', org: null }),
    ).toEqual({ authenticated: false, account: null, message: null });
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
});
