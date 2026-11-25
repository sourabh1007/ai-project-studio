import { describe, it, expect } from 'vitest';
import {
  listAzureRepos,
  parseAzureRepoLocation,
  repositoriesUrl,
  repoCloneUrl,
  type AzureHttpResponse,
} from './azure-repo-lister.js';

const okBody = (body: unknown): AzureHttpResponse => ({ status: 200, body });

describe('azure repo lister url helpers', () => {
  it('builds the org-wide repositories REST url with encoding', () => {
    expect(repositoriesUrl('my org')).toBe(
      'https://dev.azure.com/my%20org/_apis/git/repositories?api-version=7.1',
    );
  });

  it('builds a clone url for a project/repo with encoding', () => {
    expect(repoCloneUrl('org', 'Team Proj', 'my repo')).toBe(
      'https://dev.azure.com/org/Team%20Proj/_git/my%20repo',
    );
  });
});

describe('parseAzureRepoLocation', () => {
  it('returns null parts for blank input', () => {
    expect(parseAzureRepoLocation(null)).toEqual({
      org: null,
      project: null,
      repo: null,
    });
    expect(parseAzureRepoLocation('   ')).toEqual({
      org: null,
      project: null,
      repo: null,
    });
  });

  it('treats a bare name as an organization', () => {
    expect(parseAzureRepoLocation('msdata')).toEqual({
      org: 'msdata',
      project: null,
      repo: null,
    });
  });

  it('parses a dev.azure.com repository URL', () => {
    expect(
      parseAzureRepoLocation(
        'https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB',
      ),
    ).toEqual({ org: 'msdata', project: 'CosmosDB', repo: 'CosmosDB' });
  });

  it('parses a legacy visualstudio.com repository URL', () => {
    expect(
      parseAzureRepoLocation(
        'https://msdata.visualstudio.com/CosmosDB/_git/CosmosDB',
      ),
    ).toEqual({ org: 'msdata', project: 'CosmosDB', repo: 'CosmosDB' });
  });

  it('ignores trailing slashes and a missing _git repo segment', () => {
    expect(
      parseAzureRepoLocation('https://dev.azure.com/msdata/CosmosDB/_git/'),
    ).toEqual({ org: 'msdata', project: 'CosmosDB', repo: null });
  });

  it('accepts URL-shaped values without a scheme', () => {
    expect(parseAzureRepoLocation('dev.azure.com/msdata/')).toEqual({
      org: 'msdata',
      project: null,
      repo: null,
    });
  });

  it('returns a null org for host-only and malformed visualstudio.com URLs', () => {
    expect(parseAzureRepoLocation('https://dev.azure.com')).toEqual({
      org: null,
      project: null,
      repo: null,
    });
    expect(parseAzureRepoLocation('https://.visualstudio.com/')).toEqual({
      org: null,
      project: null,
      repo: null,
    });
  });

  it('falls back to the raw value when URL parsing fails', () => {
    expect(parseAzureRepoLocation('http://')).toEqual({
      org: 'http://',
      project: null,
      repo: null,
    });
  });
  it.each([
      ['https://msazure.visualstudio.com/Liftr/_git/Liftr.Nginx', 'msazure', 'Liftr', 'Liftr.Nginx'],
      ['https://msazure.visualstudio.com/DefaultCollection/Liftr/_git/Liftr.Nginx', 'msazure', 'Liftr', 'Liftr.Nginx'],
      ['https://dev.azure.com/org/Team%20Project/_git/my%20repo', 'org', 'Team Project', 'my repo'],
      ['https://dev.azure.com/org/Team%20Project', 'org', 'Team Project', null],
      ['https://org.visualstudio.com/Team%20Project', 'org', 'Team Project', null],
      ['https://org.visualstudio.com/', 'org', null, null],
      ['https://org.visualstudio.com/_git/repo', 'org', 'repo', 'repo'],
      ['https://org.visualstudio.com/_git', 'org', null, null],
      ['https://dev.azure.com/org/_git/repo', 'org', 'repo', 'repo'],
      ['https://dev.azure.com/org/_git', 'org', null, null],
      ['https://dev.azure.com/org/%E0%A4%A/_git/repo', 'org', '%E0%A4%A', 'repo'],
    ])('preserves the requested project/repository scope in %s', (url, org, project, repo) => {
      expect(parseAzureRepoLocation(url)).toEqual({ org, project, repo });
    });
});

describe('listAzureRepos', () => {
  const deps = (
    token: string | null,
    responder: (url: string) => AzureHttpResponse,
  ) => ({
    token: async () => token,
    httpGet: async (url: string) => responder(url),
  });

  it('lists every repository across projects, labelled project/repo', async () => {
    const repos = await listAzureRepos(
      deps('tok', () =>
        okBody({
          value: [
            {
              name: 'geneva_config',
              project: { name: 'CosmosDB' },
              defaultBranch: 'refs/heads/master',
              webUrl: 'https://dev.azure.com/msdata/CosmosDB/_git/geneva_config',
            },
            {
              name: 'A365',
              project: { name: 'A365' },
              defaultBranch: 'refs/heads/main',
              webUrl: 'https://dev.azure.com/msdata/A365/_git/A365',
            },
          ],
        }),
      ),
      'msdata',
    );
    // Sorted alphabetically by "project/repo".
    expect(repos).toEqual([
      {
        provider: 'azure-devops',
        name: 'A365/A365',
        remoteUrl: 'https://dev.azure.com/msdata/A365/_git/A365',
        defaultBranch: 'main',
      },
      {
        provider: 'azure-devops',
        name: 'CosmosDB/geneva_config',
        remoteUrl: 'https://dev.azure.com/msdata/CosmosDB/_git/geneva_config',
        defaultBranch: 'master',
      },
    ]);
  });

  it('falls back to a constructed clone url and null branch when fields are missing', async () => {
    const repos = await listAzureRepos(
      deps('tok', () =>
        okBody({
          value: [
            { name: 'no_web_url', project: { name: 'Proj' }, webUrl: '   ' },
          ],
        }),
      ),
      'org',
    );
    expect(repos).toEqual([
      {
        provider: 'azure-devops',
        name: 'Proj/no_web_url',
        remoteUrl: 'https://dev.azure.com/org/Proj/_git/no_web_url',
        defaultBranch: null,
      },
    ]);
  });

  it('keeps a default branch that is not refs/heads-prefixed as-is', async () => {
    const repos = await listAzureRepos(
      deps('tok', () =>
        okBody({
          value: [
            {
              name: 'repo',
              project: { name: 'Proj' },
              defaultBranch: 'develop',
              webUrl: 'https://dev.azure.com/org/Proj/_git/repo',
            },
          ],
        }),
      ),
      'org',
    );
    expect(repos[0]?.defaultBranch).toBe('develop');
  });

  it('throws when the org is blank', async () => {
    await expect(
      listAzureRepos(deps('tok', () => okBody({ value: [] })), '   '),
    ).rejects.toMatchObject({
      kind: 'validation',
      message: 'Enter an Azure DevOps organization to load repositories.',
    });
  });

  it('looks up a full repository URL directly without requiring organization-wide enumeration access', async () => {
    let tokenOrg = '';
    let requested = '';
    const repos = await listAzureRepos(
      {
        token: async (org) => {
          tokenOrg = org;
          return 'tok';
        },
        httpGet: async (url) => {
          requested = url;
          return okBody({ name: 'CosmosDB', project: { name: 'CosmosDB' } });
        },
      },
      ' https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB ',
    );
    expect(repos[0]?.name).toBe('CosmosDB/CosmosDB');
    expect(tokenOrg).toBe('msdata');
    expect(requested).toBe('https://dev.azure.com/msdata/CosmosDB/_apis/git/repositories/CosmosDB?api-version=7.1');
  });

  it.each([
    'https://msazure.visualstudio.com/Liftr/_git/Liftr.Nginx',
    'https://dev.azure.com/msazure/Liftr/_git/Liftr.Nginx',
  ])('loads the requested Liftr repository from %s', async (location) => {
    let requested = '';
    const repos = await listAzureRepos(deps('tok', (url) => {
      requested = url;
      return okBody({ name: 'Liftr.Nginx', project: { name: 'Liftr' }, defaultBranch: 'refs/heads/main' });
    }), location);
    expect(requested).toBe('https://dev.azure.com/msazure/Liftr/_apis/git/repositories/Liftr.Nginx?api-version=7.1');
    expect(repos).toEqual([{
      provider: 'azure-devops', name: 'Liftr/Liftr.Nginx',
      remoteUrl: 'https://dev.azure.com/msazure/Liftr/_git/Liftr.Nginx', defaultBranch: 'main',
    }]);
  });

  it('lists only the named project and decodes URL segments before encoding the REST path', async () => {
    let requested = '';
    await listAzureRepos(deps('tok', (url) => {
      requested = url;
      return okBody({ value: [] });
    }), 'https://dev.azure.com/org/Team%20Project');
    expect(requested).toBe('https://dev.azure.com/org/Team%20Project/_apis/git/repositories?api-version=7.1');
  });

  it('throws an auth-required error when there is no cached token', async () => {
    await expect(
      listAzureRepos(deps(null, () => okBody({ value: [] })), 'org'),
    ).rejects.toMatchObject({
      kind: 'auth_required', provider: 'azure-devops',
      message: 'Studio could not obtain a usable Azure DevOps credential for organization "org". Other organizations may still be connected. Check the organization (not the project), or paste the full repository URL, then sign in for that organization.',
    });
  });

  it.each([
    'https://dev.azure.com/fabrikam/Team%20Project/_git/my%20repo',
    'https://fabrikam.visualstudio.com/DefaultCollection/Team%20Project/_git/my%20repo',
  ])('keeps credential and repository scope generic for %s', async (location) => {
    const requests: string[] = [];
    const tokens: string[] = [];
    const service = {
      token: async (org: string) => { tokens.push(org); return org === 'fabrikam' ? 'tok' : null; },
      httpGet: async (url: string) => {
        requests.push(url);
        return okBody({ name: 'my repo', project: { name: 'Team Project' } });
      },
    };
    await expect(listAzureRepos(service, 'another-org')).rejects.toMatchObject({ kind: 'auth_required' });
    const repos = await listAzureRepos(service, location);
    expect(tokens).toEqual(['another-org', 'fabrikam']);
    expect(requests).toEqual(['https://dev.azure.com/fabrikam/Team%20Project/_apis/git/repositories/my%20repo?api-version=7.1']);
    expect(repos[0].name).toBe('Team Project/my repo');
  });

  it('prompts for sign-in only for 401, not a permission denial', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 401, body: null })), 'org'),
    ).rejects.toMatchObject({ kind: 'auth_required' });
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 403, body: null })), 'org'),
    ).rejects.toMatchObject({ kind: 'provider', message: expect.stringContaining('denied repository access') });
  });

  it('throws a provider error for an inaccessible org', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 404, body: null })), 'badorg'),
    ).rejects.toMatchObject({
      kind: 'provider',
      message:
        'Azure DevOps location "badorg" was not found or you do not have access. Check the organization, project and repository URL.',
    });
  });

  it('throws a friendly provider error when the repositories request fails otherwise', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 500, body: null })), 'org'),
    ).rejects.toMatchObject({
      kind: 'provider',
      message: 'Could not load Azure DevOps repositories (HTTP 500). Please try again.',
    });
  });

  it('skips repos missing a name or project, and disabled repos', async () => {
    const repos = await listAzureRepos(
      deps('tok', () =>
        okBody({
          value: [
            { project: { name: 'Proj' } },
            { name: 'Orphan' },
            {
              name: 'Disabled',
              project: { name: 'Proj' },
              isDisabled: true,
            },
            {
              name: 'Good',
              project: { name: 'Proj' },
              webUrl: 'https://dev.azure.com/org/Proj/_git/Good',
            },
          ],
        }),
      ),
      'org',
    );
    expect(repos).toEqual([
      {
        provider: 'azure-devops',
        name: 'Proj/Good',
        remoteUrl: 'https://dev.azure.com/org/Proj/_git/Good',
        defaultBranch: null,
      },
    ]);
  });

  it('treats a body without a value array as empty', async () => {
    const repos = await listAzureRepos(
      deps('tok', () => okBody({ notValue: true })),
      'org',
    );
    expect(repos).toEqual([]);
  });
});
