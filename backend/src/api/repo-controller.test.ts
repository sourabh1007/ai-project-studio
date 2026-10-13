import { describe, it, expect } from 'vitest';
import { createRepoRoutes } from './repo-controller.js';
import type { RepoService } from '../repo/repo-service.js';
import type { Repository } from '../repo/repo-contract.js';
import type { RemoteRepo } from '../repo/remote-repo-contract.js';
import type { RemotePullRequest } from '../repo/remote-pr-contract.js';
import type {
  RemoteWorkItem,
  RemoteIssue,
} from '../repo/remote-import-contract.js';
import type { PrFeatureService } from '../repo/pr-feature-service.js';
import type { Feature } from '../feature/feature-contract.js';
import type { HttpRequest, Route } from './http-contract.js';
import type { RepositoryContext } from '../repository-context/repository-context-contract.js';
import type { RepositoryContextCoordinator } from '../repository-context/repository-context-coordinator.js';
import type { RepoInsights } from '../repo-insights/repo-insights-contract.js';

const repo: Repository = {
  id: 'r1',
  provider: 'github',
  remoteUrl: 'https://github.com/acme/app.git',
  name: 'acme/app',
  localPath: 'C:/work/app',
  defaultBranch: 'main',
  createdAt: '2025-01-01T00:00:00.000Z',
};

const pull: RemotePullRequest = {
  provider: 'github',
  number: 12,
  title: 'Add login',
  url: 'https://github.com/acme/app/pull/12',
  sourceBranch: 'feature/login',
  author: 'Mona',
};

const reviewFeature: Feature = {
  id: 'f9',
  name: 'PR #12: Add login',
  description: pull.url,
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
  repoId: 'r1',
  checkoutPath: 'C:/wt/app-pr-12',
};

const workItem: RemoteWorkItem = {
  provider: 'azure-devops',
  id: 101,
  title: 'Fix cache',
  url: 'https://dev.azure.com/acme/proj/_workitems/edit/101',
  type: 'Bug',
  state: 'Active',
  assignedTo: 'Mona',
  description: 'Fix cache details',
};
const workItems = [workItem];
const workItemComments = ['Looks good', 'Please add tests'];

const issue: RemoteIssue = {
  provider: 'github',
  number: 42,
  title: 'Crash on launch',
  url: 'https://github.com/acme/app/issues/42',
  state: 'open',
  author: 'octocat',
  assignees: ['hubot'],
  labels: ['bug'],
  createdAt: '2025-01-01T00:00:00.000Z',
};
const issues = [issue];

const repositoryContext: RepositoryContext = {
  repositoryId: 'r1',
  status: 'ready',
  content: 'context',
  sourceRevision: 'a'.repeat(40),
  timestamps: {
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:01:00.000Z',
    generationStartedAt: '2025-01-01T00:00:10.000Z',
    generatedAt: '2025-01-01T00:01:00.000Z',
  },
  steps: [],
  failure: null,
};

const repoInsights: RepoInsights = {
  repositoryId: 'r1',
  branch: 'main',
  agents: [],
  skills: [],
  docs: [],
  readiness: [],
  agentReady: true,
  generatedAt: '2025-01-01T00:02:00.000Z',
};

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function harness() {
  const created: unknown[] = [];
  const provisioned: unknown[] = [];
  const removed: string[] = [];
  const reviewed: Array<{ repoId: string; number: number }> = [];
  const listedFilters: string[] = [];
  const initialized: string[] = [];
  const loaded: string[] = [];
  const refreshed: string[] = [];
  const contextRemoved: string[] = [];
  const insightsLoaded: string[] = [];
  const insightsRefresh: boolean[] = [];
  const definitionReads: Array<{ id: string; path: string }> = [];
  const workItemRepoIds: string[] = [];
  const workItemFilters: unknown[] = [];
  const workItemCommentRequests: Array<{ repoId: string; workItemId: number }> = [];
  const issueRepoIds: string[] = [];
  const issueFilters: string[] = [];
  const reprovisioned: unknown[] = [];
  let azureOrg = '';
  const service = {
    list: () => [repo],
    get: (id: string) => {
      if (id !== repo.id) {
        throw new Error(`Unknown repository: ${id}`);
      }
      return repo;
    },
    create: (input: unknown) => {
      created.push(input);
      return repo;
    },
    updateLocalPath: (input: { id: string; localPath: string }) => {
      reprovisioned.push(input);
      return { ...repo, localPath: input.localPath };
    },
    remove: (id: string) => void removed.push(id),
  } as unknown as RepoService;
  const github: RemoteRepo[] = [
    {
      provider: 'github',
      name: 'acme/app',
      remoteUrl: 'https://github.com/acme/app.git',
      defaultBranch: 'main',
    },
  ];
  const prFeatures: PrFeatureService = {
    listPulls: async (repoId, filter = 'all') => {
      reviewed.push({ repoId, number: 0 });
      listedFilters.push(filter);
      return [pull];
    },
    createFromPull: async (repoId, number) => {
      reviewed.push({ repoId, number });
      return { feature: reviewFeature, alreadyImported: false };
    },
    pullLatest: async () => {
      throw new Error('not used in repo-controller tests');
    },
  };
  const repositoryContexts: RepositoryContextCoordinator = {
    get: () => repositoryContext,
    load: async (id) => {
      loaded.push(id);
      return repositoryContext;
    },
    ensureFresh: async () => repositoryContext,
    initialize: (id) => {
      initialized.push(id);
      return { ...repositoryContext, status: 'pending' };
    },
    refresh: (id) => {
      refreshed.push(id);
      return { ...repositoryContext, status: 'generating' };
    },
    synchronizeSaved: async () => undefined,
    remove: (id) => void contextRemoved.push(id),
  };
  const routes = createRepoRoutes({
    repos: service,
    repositoryContexts,
    repoInsights: {
      load: async (id, options) => {
        insightsLoaded.push(id);
        insightsRefresh.push(options?.refresh ?? false);
        return repoInsights;
      },
      readDefinition: async (id, path) => {
        definitionReads.push({ id, path });
        return { path, branch: 'main', content: `content of ${path}` };
      },
      analyzeStream: async () => undefined,
    },
    provision: async (input) => {
      provisioned.push(input);
      return {
        provider: input.provider,
        remoteUrl: input.remoteUrl,
        name: input.name,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch ?? null,
      };
    },
    listGithubRepos: async () => github,
    listAzureRepos: async (org) => {
      azureOrg = org;
      return [];
    },
    listRepoWorkItems: async (repoId, filter) => {
      workItemRepoIds.push(repoId);
      workItemFilters.push(filter);
      return workItems;
    },
    listRepoWorkItemComments: async (repoId, workItemId) => {
      workItemCommentRequests.push({ repoId, workItemId });
      return workItemComments;
    },
    listRepoIssues: async (repoId, filter) => {
      issueRepoIds.push(repoId);
      issueFilters.push(filter);
      return issues;
    },
    prFeatures,
  });
  return {
    routes,
    created,
    provisioned,
    removed,
    reviewed,
    listedFilters,
    initialized,
    loaded,
    refreshed,
    contextRemoved,
    insightsLoaded,
    insightsRefresh,
    definitionReads,
    workItemRepoIds,
    workItemFilters,
    workItemCommentRequests,
    issueRepoIds,
    issueFilters,
    reprovisioned,
    getAzureOrg: () => azureOrg,
  };
}

describe('repo-controller', () => {
  it('lists saved repositories', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos')(req());
    expect(result).toEqual({ status: 200, body: [repo] });
  });

  it('provisions and creates a repository, returning 201', async () => {
    const h = harness();
    const body = {
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:/work/app',
      mode: 'clone',
    };
    const result = await pick(h.routes, 'post', '/repos')(req({ body }));
    expect(result.status).toBe(201);
    expect(result.body).toBe(repo);
    expect(h.provisioned).toEqual([{ ...body, defaultBranch: undefined }]);
    expect(h.created).toHaveLength(1);
    expect(h.initialized).toEqual(['r1']);
  });

  it('rejects invalid create payloads', async () => {
    const h = harness();
    await expect(
      pick(h.routes, 'post', '/repos')(req({ body: { provider: 'nope' } })),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('re-provisions an existing repository in place, keeping its id', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/repos/:id/reprovision')(
      req({
        params: { id: 'r1' },
        body: { localPath: 'D:/work/app', mode: 'existing' },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 'r1', localPath: 'D:/work/app' });
    // Provision runs from the stored repo's provider/remote, not client input.
    expect(h.provisioned).toEqual([
      {
        provider: repo.provider,
        remoteUrl: repo.remoteUrl,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        localPath: 'D:/work/app',
        mode: 'existing',
      },
    ]);
    expect(h.reprovisioned).toEqual([
      expect.objectContaining({ id: 'r1', localPath: 'D:/work/app' }),
    ]);
  });

  it('rejects invalid reprovision payloads', async () => {
    const h = harness();
    await expect(
      pick(h.routes, 'post', '/repos/:id/reprovision')(
        req({ params: { id: 'r1' }, body: { mode: 'clone' } }),
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('deletes a repository and returns its id', async () => {
    const h = harness();
    const result = await pick(h.routes, 'delete', '/repos/:id')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 'r1' } });
    expect(h.removed).toEqual(['r1']);
    expect(h.contextRemoved).toEqual(['r1']);
  });

  it('gets repository context', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/context')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: repositoryContext });
    expect(h.loaded).toEqual(['r1']);
  });

  it('gets repository insights', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/insights')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: repoInsights });
    expect(h.insightsLoaded).toEqual(['r1']);
    expect(h.insightsRefresh).toEqual([false]);
  });

  it('forces a rescan when the refresh query is set', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/insights')(
      req({ params: { id: 'r1' }, query: { refresh: 'true' } }),
    );
    expect(result).toEqual({ status: 200, body: repoInsights });
    expect(h.insightsRefresh).toEqual([true]);
  });

  it('reads a definition file by path query', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/insights/file')(
      req({ params: { id: 'r1' }, query: { path: 'docs/guide.md' } }),
    );
    expect(result).toEqual({
      status: 200,
      body: { path: 'docs/guide.md', branch: 'main', content: 'content of docs/guide.md' },
    });
    expect(h.definitionReads).toEqual([{ id: 'r1', path: 'docs/guide.md' }]);
  });

  it('defaults a missing file path query to an empty string', async () => {
    const h = harness();
    await pick(h.routes, 'get', '/repos/:id/insights/file')(
      req({ params: { id: 'r1' } }),
    );
    expect(h.definitionReads).toEqual([{ id: 'r1', path: '' }]);
  });

  it('accepts an empty refresh body and returns the generating context', async () => {
    const h = harness();
    const result = await pick(
      h.routes,
      'post',
      '/repos/:id/context/refresh',
    )(req({ params: { id: 'r1' }, body: {} }));
    expect(result).toEqual({
      status: 202,
      body: { ...repositoryContext, status: 'generating' },
    });
    expect(h.refreshed).toEqual(['r1']);
  });

  it('rejects unexpected repository context refresh input', async () => {
    const h = harness();
    expect(() =>
      pick(h.routes, 'post', '/repos/:id/context/refresh')(
        req({ params: { id: 'r1' }, body: { force: true } }),
      ),
    ).toThrow('Invalid request');
  });

  it('lists GitHub repositories', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/providers/github/repos')(req());
    expect(result.status).toBe(200);
    expect((result.body as RemoteRepo[])[0].name).toBe('acme/app');
  });

  it('lists Azure DevOps repositories for the requested org', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/providers/azure-devops/repos')(
      req({ query: { org: 'contoso' } }),
    );
    expect(result).toEqual({ status: 200, body: [] });
    expect(h.getAzureOrg()).toBe('contoso');
  });

  it('defaults the Azure org to empty when the query param is absent', async () => {
    const h = harness();
    await pick(h.routes, 'get', '/providers/azure-devops/repos')(req());
    expect(h.getAzureOrg()).toBe('');
  });

  it('lists a repository pull requests', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/pulls')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: [pull] });
    expect(h.reviewed[0].repoId).toBe('r1');
    expect(h.listedFilters[0]).toBe('all');
  });

  it('passes the mine / assigned filter through, ignoring unknown values', async () => {
    const h = harness();
    await pick(h.routes, 'get', '/repos/:id/pulls')(
      req({ params: { id: 'r1' }, query: { filter: 'mine' } }),
    );
    await pick(h.routes, 'get', '/repos/:id/pulls')(
      req({ params: { id: 'r1' }, query: { filter: 'assigned' } }),
    );
    await pick(h.routes, 'get', '/repos/:id/pulls')(
      req({ params: { id: 'r1' }, query: { filter: 'bogus' } }),
    );
    expect(h.listedFilters).toEqual(['mine', 'assigned', 'all']);
  });

  it('creates a review feature from a pull request', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/repos/:id/pulls')(
      req({ params: { id: 'r1' }, body: { number: 12 } }),
    );
    expect(result).toEqual({
      status: 201,
      body: { ...reviewFeature, alreadyImported: false },
    });
    expect(h.reviewed).toContainEqual({ repoId: 'r1', number: 12 });
  });

  it('rejects an invalid pull-request number', async () => {
    const h = harness();
    await expect(
      pick(h.routes, 'post', '/repos/:id/pulls')(
        req({ params: { id: 'r1' }, body: { number: -1 } }),
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('lists a repository work items, defaulting the filter to @Me', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/work-items')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: [workItem] });
    expect(h.workItemRepoIds).toEqual(['r1']);
    expect(h.workItemFilters).toEqual([
      {
        assignedTo: 'me',
        state: undefined,
        area: undefined,
        iteration: undefined,
        tag: undefined,
      },
    ]);
  });

  it('parses the work-item filter query params, trimming blanks', async () => {
    const h = harness();
    await pick(h.routes, 'get', '/repos/:id/work-items')(
      req({
        params: { id: 'r1' },
        query: {
          assignedTo: 'all',
          state: 'Active',
          area: ' Proj\\Team ',
          iteration: '',
          tag: 'GSI',
        },
      }),
    );
    expect(h.workItemFilters).toEqual([
      {
        assignedTo: 'all',
        state: 'Active',
        area: 'Proj\\Team',
        iteration: undefined,
        tag: 'GSI',
      },
    ]);
  });

  it('lists comments for a repository work item', async () => {
    const h = harness();
    const result = await pick(
      h.routes,
      'get',
      '/repos/:id/work-items/:wid/comments',
    )(req({ params: { id: 'r1', wid: '101' } }));
    expect(result).toEqual({ status: 200, body: workItemComments });
    expect(h.workItemCommentRequests).toEqual([
      { repoId: 'r1', workItemId: 101 },
    ]);
  });

  it('lists a repository issues, passing the filter through', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/repos/:id/issues')(
      req({ params: { id: 'r1' }, query: { filter: 'mine' } }),
    );
    expect(result).toEqual({ status: 200, body: [issue] });
    expect(h.issueRepoIds).toEqual(['r1']);
    expect(h.issueFilters).toEqual(['mine']);
  });

  it('defaults an unknown issue filter to all', async () => {
    const h = harness();
    await pick(h.routes, 'get', '/repos/:id/issues')(
      req({ params: { id: 'r1' }, query: { filter: 'bogus' } }),
    );
    expect(h.issueFilters).toEqual(['all']);
  });
});
