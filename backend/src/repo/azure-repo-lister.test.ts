import { describe, it, expect } from 'vitest';
import {
  listAzureRepos,
  projectsUrl,
  projectRepoUrl,
  PROJECTS_PAGE_SIZE,
  type AzureHttpResponse,
} from './azure-repo-lister.js';

const okBody = (body: unknown): AzureHttpResponse => ({ status: 200, body });

describe('azure repo lister url helpers', () => {
  it('builds a paginated projects REST url with encoding', () => {
    expect(projectsUrl('my org', 200, 400)).toBe(
      'https://dev.azure.com/my%20org/_apis/projects?api-version=7.1&$top=200&$skip=400',
    );
  });

  it('builds the default-repo clone url for a project', () => {
    expect(projectRepoUrl('org', 'Team Proj')).toBe(
      'https://dev.azure.com/org/Team%20Proj/_git/Team%20Proj',
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

  it('maps each project to its default repository', async () => {
    const repos = await listAzureRepos(
      deps('tok', () =>
        okBody({ value: [{ name: 'HDInsight' }, { name: 'A365' }] }),
      ),
      'msdata',
    );
    expect(repos).toEqual([
      {
        provider: 'azure-devops',
        name: 'HDInsight',
        remoteUrl: 'https://dev.azure.com/msdata/HDInsight/_git/HDInsight',
        defaultBranch: null,
      },
      {
        provider: 'azure-devops',
        name: 'A365',
        remoteUrl: 'https://dev.azure.com/msdata/A365/_git/A365',
        defaultBranch: null,
      },
    ]);
  });

  it('throws when the org is blank', async () => {
    await expect(
      listAzureRepos(deps('tok', () => okBody({ value: [] })), '   '),
    ).rejects.toThrow('organization is required');
  });

  it('throws when there is no cached token', async () => {
    await expect(
      listAzureRepos(deps(null, () => okBody({ value: [] })), 'org'),
    ).rejects.toThrow('Not signed in');
  });

  it('throws when the first projects page is not 200', async () => {
    await expect(
      listAzureRepos(deps('tok', () => ({ status: 403, body: null })), 'org'),
    ).rejects.toThrow('HTTP 403');
  });

  it('skips nameless projects and a non-array body', async () => {
    const repos = await listAzureRepos(
      deps('tok', () => okBody({ value: [{}, { name: 'Good' }] })),
      'org',
    );
    expect(repos).toEqual([
      {
        provider: 'azure-devops',
        name: 'Good',
        remoteUrl: 'https://dev.azure.com/org/Good/_git/Good',
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

  it('paginates until a short page and stops on a later non-200', async () => {
    const firstPage = {
      value: Array.from({ length: PROJECTS_PAGE_SIZE }, (_, i) => ({
        name: `P${i}`,
      })),
    };
    let calls = 0;
    const repos = await listAzureRepos(
      deps('tok', () => {
        calls += 1;
        // First full page keeps paging; the second call fails but, being past
        // the first page, we keep what we already collected instead of throwing.
        return calls === 1 ? okBody(firstPage) : { status: 500, body: null };
      }),
      'org',
    );
    expect(repos).toHaveLength(PROJECTS_PAGE_SIZE);
    expect(calls).toBe(2);
  });

  it('stops paging when a full page is followed by a short page', async () => {
    const full = {
      value: Array.from({ length: PROJECTS_PAGE_SIZE }, (_, i) => ({
        name: `P${i}`,
      })),
    };
    let calls = 0;
    const repos = await listAzureRepos(
      deps('tok', () => {
        calls += 1;
        return calls === 1 ? okBody(full) : okBody({ value: [{ name: 'Last' }] });
      }),
      'org',
    );
    expect(repos).toHaveLength(PROJECTS_PAGE_SIZE + 1);
    expect(calls).toBe(2);
  });
});
