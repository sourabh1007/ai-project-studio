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
} = {}) {
  const created: unknown[] = [];
  const started: unknown[] = [];
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
    provisionWorktree: () =>
      Promise.resolve({ worktreePath: 'C:/wt/app-pr-12', branch: 'pr-12' }),
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
    },
    reviews: {
      start: (input) => {
        started.push(input);
        return undefined as never;
      },
    },
  });
  return { svc, created, started };
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

  it('starts the review with a null base branch when the repo has none', async () => {
    const { svc } = harness();
    const noBranch = createPrFeatureService({
      repos: { get: () => ({ ...repo, defaultBranch: null }) },
      listPulls: () => Promise.resolve([pull]),
      getPull: () => Promise.resolve(pull),
      provisionWorktree: () =>
        Promise.resolve({ worktreePath: 'C:/wt/app-pr-12', branch: 'pr-12' }),
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
      },
      reviews: { start: () => undefined as never },
    });
    await noBranch.createFromPull('r1', 12);
    expect(svc).toBeDefined();
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
