import { describe, it, expect } from 'vitest';
import { AppError } from '../kernel/error-types.js';
import { createPrFeatureService } from './pr-feature-service.js';
import type { Repository } from './repo-contract.js';
import type { RemotePullRequest } from './remote-pr-contract.js';

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

function harness(overrides: {
  getPull?: () => Promise<RemotePullRequest | null>;
  findByPull?: (repoId: string, pullNumber: number) => string | null;
} = {}) {
  const created: unknown[] = [];
  const started: unknown[] = [];
  const provisioned: unknown[] = [];
  const existingFeature = {
    id: 'existing-f',
    name: 'PR #12: Add login',
    description: 'https://github.com/acme/app/pull/12',
    createdAt: '2025-01-01T00:00:00.000Z',
    summary: null,
    repoId: repo.id,
    checkoutPath: 'C:/wt/app-pr-12',
  };
  const svc = createPrFeatureService({
    repos: {
      get: (id) => {
        if (id !== repo.id) {
          throw new AppError('not_found', `Unknown repository: ${id}`);
        }
        return repo;
      },
    },
    listPulls: () => Promise.resolve([pull]),
    getPull: overrides.getPull ?? (() => Promise.resolve(pull)),
    provisionWorktree: () => {
      provisioned.push(true);
      return Promise.resolve({
        worktreePath: 'C:/wt/app-pr-12',
        branch: 'pr-12',
        tracksPullRequest: false,
      });
    },
    features: {
      create: (input) => {
        created.push(input);
        return {
          id: 'f1',
          name: input.name,
          description: input.description,
          createdAt: '2025-01-01T00:00:00.000Z',
          summary: null,
          repoId: input.repoId ?? null,
          checkoutPath: input.checkoutPath ?? null,
        };
      },
      get: () => existingFeature,
    },
    reviews: {
      start: (input) => {
        started.push(input);
        return undefined as never;
      },
      findByPull: overrides.findByPull ?? (() => null),
    },
  });
  return { svc, created, started, provisioned, existingFeature };
}

describe('pr-feature-service', () => {
  it('lists pull requests for a repository', async () => {
    const { svc } = harness();
    expect(await svc.listPulls('r1')).toEqual([pull]);
  });

  it('propagates an unknown repository from listPulls', async () => {
    const { svc } = harness();
    await expect(svc.listPulls('nope')).rejects.toThrow(AppError);
  });

  it('creates a feature in the PR worktree', async () => {
    const { svc, created, started } = harness();
    const feature = await svc.createFromPull('r1', 12);
    expect(feature).toMatchObject({
      name: 'PR #12: Add login',
      description: 'https://github.com/acme/app/pull/12',
      repoId: 'r1',
      checkoutPath: 'C:/wt/app-pr-12',
    });
    expect(created).toEqual([
      {
        name: 'PR #12: Add login',
        description: 'https://github.com/acme/app/pull/12',
        repoId: 'r1',
        checkoutPath: 'C:/wt/app-pr-12',
      },
    ]);
    expect(started).toEqual([
      {
        featureId: 'f1',
        repoId: 'r1',
        pull,
        worktreePath: 'C:/wt/app-pr-12',
        baseBranch: 'main',
      },
    ]);
  });

  it('prefers the PR target branch over the repo default as the diff base', async () => {
    const { svc, started } = harness({
      getPull: () =>
        Promise.resolve({ ...pull, targetBranch: 'release/2.0' }),
    });
    await svc.createFromPull('r1', 12);
    expect(started).toEqual([
      {
        featureId: 'f1',
        repoId: 'r1',
        pull: { ...pull, targetBranch: 'release/2.0' },
        worktreePath: 'C:/wt/app-pr-12',
        baseBranch: 'release/2.0',
      },
    ]);
  });

  it('starts the review with a null base branch when the repo has none', async () => {
    const started: unknown[] = [];
    const noBranch = createPrFeatureService({
      repos: { get: () => ({ ...repo, defaultBranch: null }) },
      listPulls: () => Promise.resolve([pull]),
      getPull: () => Promise.resolve(pull),
      provisionWorktree: () =>
        Promise.resolve({
          worktreePath: 'C:/wt/app-pr-12',
          branch: 'pr-12',
          tracksPullRequest: false,
        }),
      features: {
        create: (input) => ({
          id: 'f1',
          name: input.name,
          description: input.description,
          createdAt: '2025-01-01T00:00:00.000Z',
          summary: null,
          repoId: input.repoId ?? null,
          checkoutPath: input.checkoutPath ?? null,
        }),
        get: () => {
          throw new Error('should not be called');
        },
      },
      reviews: {
        start: (input) => {
          started.push(input);
          return undefined as never;
        },
        findByPull: () => null,
      },
    });
    await noBranch.createFromPull('r1', 12);
    expect(started).toEqual([
      {
        featureId: 'f1',
        repoId: 'r1',
        pull,
        worktreePath: 'C:/wt/app-pr-12',
        baseBranch: null,
      },
    ]);
  });

  it('reuses the existing review feature when the PR is already open', async () => {
    const { svc, created, started, provisioned, existingFeature } = harness({
      findByPull: () => 'existing-f',
    });
    const feature = await svc.createFromPull('r1', 12);
    expect(feature).toBe(existingFeature);
    expect(created).toEqual([]);
    expect(started).toEqual([]);
    expect(provisioned).toEqual([]);
  });

  it('throws NotFound when the pull request does not exist', async () => {
    const { svc } = harness({ getPull: () => Promise.resolve(null) });
    await expect(svc.createFromPull('r1', 99)).rejects.toThrow(
      'Pull request #99 not found',
    );
  });

  it('propagates an unknown repository from createFromPull', async () => {
    const { svc } = harness();
    await expect(svc.createFromPull('nope', 12)).rejects.toThrow(AppError);
  });
});
