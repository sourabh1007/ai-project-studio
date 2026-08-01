import { describe, it, expect } from 'vitest';
import { createRepoRoutes } from './repo-controller.js';
import type { RepoService } from '../repo/repo-service.js';
import type { Repository } from '../repo/repo-contract.js';
import type { RemoteRepo } from '../repo/remote-repo-contract.js';
import type { RemotePullRequest } from '../repo/remote-pr-contract.js';
import type { PrFeatureService } from '../repo/pr-feature-service.js';
import type { Feature } from '../feature/feature-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

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
  let azureOrg = '';
  const service = {
    list: () => [repo],
    create: (input: unknown) => {
      created.push(input);
      return repo;
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
    listPulls: async (repoId) => {
      reviewed.push({ repoId, number: 0 });
      return [pull];
    },
    createFromPull: async (repoId, number) => {
      reviewed.push({ repoId, number });
      return reviewFeature;
    },
  };
  const routes = createRepoRoutes({
    repos: service,
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
    prFeatures,
  });
  return {
    routes,
    created,
    provisioned,
    removed,
    reviewed,
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
  });

  it('rejects invalid create payloads', async () => {
    const h = harness();
    await expect(
      pick(h.routes, 'post', '/repos')(req({ body: { provider: 'nope' } })),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('deletes a repository and returns its id', async () => {
    const h = harness();
    const result = await pick(h.routes, 'delete', '/repos/:id')(
      req({ params: { id: 'r1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 'r1' } });
    expect(h.removed).toEqual(['r1']);
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
  });

  it('creates a review feature from a pull request', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/repos/:id/pulls')(
      req({ params: { id: 'r1' }, body: { number: 12 } }),
    );
    expect(result).toEqual({ status: 201, body: reviewFeature });
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
});
