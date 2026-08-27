import { describe, it, expect } from 'vitest';
import {
  listAzureRepos,
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
    ).rejects.toThrow('organization is required');
  });

  it('throws an auth-required error when there is no cached token', async () => {
    await expect(
      listAzureRepos(deps(null, () => okBody({ value: [] })), 'org'),
    ).rejects.toMatchObject({ kind: 'auth_required', provider: 'azure-devops' });
  });

  it('throws an auth-required error when the request is 401 or 403', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 401, body: null })), 'org'),
    ).rejects.toMatchObject({ kind: 'auth_required' });
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 403, body: null })), 'org'),
    ).rejects.toMatchObject({ kind: 'auth_required' });
  });

  it('throws a generic error when the repositories request fails otherwise', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 500, body: null })), 'org'),
    ).rejects.toThrow('HTTP 500');
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
