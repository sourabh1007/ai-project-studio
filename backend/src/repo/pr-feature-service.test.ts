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
  find?: (featureId: string) => { repoId: string; pull: { number: number } } | null;
} = {}) {
  const created: unknown[] = [];
  const started: unknown[] = [];
  const provisioned: unknown[] = [];
  const refreshed: string[] = [];
  const attached: string[] = [];
  const checkoutPaths: Array<{ id: string; path: string | null }> = [];
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
        headSha: 'provisionedsha',
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
      setCheckoutPath: (id, path) => {
        checkoutPaths.push({ id, path });
        return { ...existingFeature, checkoutPath: path };
      },
    },
    reviews: {
      start: (input) => {
        started.push(input);
        return undefined as never;
      },
      findByPull: overrides.findByPull ?? (() => null),
      find: (overrides.find ?? (() => ({ repoId: repo.id, pull: { number: 12 } }))) as never,
      refresh: (featureId) => {
        refreshed.push(featureId);
        return { featureId } as never;
      },
    },
    onReviewFeatureCreated: (featureId) => attached.push(featureId),
  });
  return { svc, created, started, provisioned, refreshed, attached, checkoutPaths, existingFeature };
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
    const { svc, created, started, attached } = harness();
    const feature = await svc.createFromPull('r1', 12);
    expect(attached).toEqual(['f1']);
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
        parentFeatureId: null,
        parentGroupId: null,
      },
    ]);
    expect(started).toEqual([
      {
        featureId: 'f1',
        repoId: 'r1',
        pull,
        worktreePath: 'C:/wt/app-pr-12',
        headSha: 'provisionedsha',
        baseBranch: 'main',
      },
    ]);
  });

  it('nests the review under a parent feature when one is given', async () => {
    const { svc, created } = harness();
    await svc.createFromPull('r1', 12, 'parent-feat');
    expect(created).toEqual([
      {
        name: 'PR #12: Add login',
        description: 'https://github.com/acme/app/pull/12',
        repoId: 'r1',
        checkoutPath: 'C:/wt/app-pr-12',
        parentFeatureId: 'parent-feat',
        parentGroupId: null,
      },
    ]);
  });

  it('places the review inside a subcategory group when one is given', async () => {
    const { svc, created } = harness();
    await svc.createFromPull('r1', 12, 'parent-feat', 'grp-7');
    expect(created).toEqual([
      {
        name: 'PR #12: Add login',
        description: 'https://github.com/acme/app/pull/12',
        repoId: 'r1',
        checkoutPath: 'C:/wt/app-pr-12',
        parentFeatureId: null,
        parentGroupId: 'grp-7',
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
        headSha: 'provisionedsha',
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
          headSha: 'provisionedsha',
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
        setCheckoutPath: () => {
          throw new Error('should not be called');
        },
      },
      reviews: {
        start: (input) => {
          started.push(input);
          return undefined as never;
        },
        findByPull: () => null,
        find: () => null,
        refresh: (featureId) => ({ featureId }) as never,
      },
    });
    await noBranch.createFromPull('r1', 12);
    expect(started).toEqual([
      {
        featureId: 'f1',
        repoId: 'r1',
        pull,
        worktreePath: 'C:/wt/app-pr-12',
        headSha: 'provisionedsha',
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

  describe('convertToPrFeature', () => {
    it('converts the same feature in place, repoints its worktree and starts the review', async () => {
      const { svc, created, started, attached, checkoutPaths, provisioned } =
        harness({ find: () => null });
      const feature = await svc.convertToPrFeature('r1', 12, 'existing-f');
      // No child feature is created — the existing one is reused.
      expect(created).toEqual([]);
      expect(provisioned).toEqual([true]);
      expect(checkoutPaths).toEqual([
        { id: 'existing-f', path: 'C:/wt/app-pr-12' },
      ]);
      expect(feature).toMatchObject({
        id: 'existing-f',
        checkoutPath: 'C:/wt/app-pr-12',
      });
      expect(started).toEqual([
        {
          featureId: 'existing-f',
          repoId: 'r1',
          pull,
          worktreePath: 'C:/wt/app-pr-12',
          headSha: 'provisionedsha',
          baseBranch: 'main',
        },
      ]);
      expect(attached).toEqual(['existing-f']);
    });

    it('is idempotent when the feature is already a PR feature', async () => {
      const { svc, started, provisioned, checkoutPaths, existingFeature } =
        harness({ find: () => ({ repoId: repo.id, pull: { number: 12 } }) });
      const feature = await svc.convertToPrFeature('r1', 12, 'existing-f');
      expect(feature).toBe(existingFeature);
      expect(provisioned).toEqual([]);
      expect(started).toEqual([]);
      expect(checkoutPaths).toEqual([]);
    });

    it('throws NotFound when the pull request does not exist', async () => {
      const { svc } = harness({
        find: () => null,
        getPull: () => Promise.resolve(null),
      });
      await expect(
        svc.convertToPrFeature('r1', 99, 'existing-f'),
      ).rejects.toThrow('Pull request #99 not found');
    });

    it('propagates an unknown repository', async () => {
      const { svc } = harness({ find: () => null });
      await expect(
        svc.convertToPrFeature('nope', 12, 'existing-f'),
      ).rejects.toThrow(AppError);
    });

    it('prefers the PR target branch over the repo default as the diff base', async () => {
      const { svc, started } = harness({
        find: () => null,
        getPull: () => Promise.resolve({ ...pull, targetBranch: 'release/2.0' }),
      });
      await svc.convertToPrFeature('r1', 12, 'existing-f');
      expect((started[0] as { baseBranch: string }).baseBranch).toBe(
        'release/2.0',
      );
    });

    it('starts the review with a null base branch when the repo has none', async () => {
      const started: unknown[] = [];
      const svc = createPrFeatureService({
        repos: { get: () => ({ ...repo, defaultBranch: null }) },
        listPulls: () => Promise.resolve([pull]),
        getPull: () => Promise.resolve(pull),
        provisionWorktree: () =>
          Promise.resolve({
            worktreePath: 'C:/wt/app-pr-12',
            branch: 'pr-12',
            tracksPullRequest: false,
            headSha: 'provisionedsha',
          }),
        features: {
          create: () => {
            throw new Error('should not be called');
          },
          get: () => ({
            id: 'existing-f',
            name: 'Task',
            description: '',
            createdAt: '2025-01-01T00:00:00.000Z',
            summary: null,
            repoId: repo.id,
            checkoutPath: null,
          }),
          setCheckoutPath: (id, path) => ({
            id,
            name: 'Task',
            description: '',
            createdAt: '2025-01-01T00:00:00.000Z',
            summary: null,
            repoId: repo.id,
            checkoutPath: path,
          }),
        },
        reviews: {
          start: (input) => {
            started.push(input);
            return undefined as never;
          },
          findByPull: () => null,
          find: () => null,
          refresh: (featureId) => ({ featureId }) as never,
        },
      });
      await svc.convertToPrFeature('r1', 12, 'existing-f');
      expect((started[0] as { baseBranch: string | null }).baseBranch).toBeNull();
    });
  });

  describe('pullLatest', () => {
    it('re-provisions the worktree from the remote and refreshes the review', async () => {
      const { svc, provisioned, refreshed } = harness();
      const result = await svc.pullLatest('f1');
      expect(provisioned).toEqual([true]);
      expect(refreshed).toEqual(['f1']);
      expect(result).toMatchObject({ featureId: 'f1' });
    });

    it('throws NotFound when the review does not exist', async () => {
      const { svc, provisioned } = harness({ find: () => null });
      await expect(svc.pullLatest('missing')).rejects.toThrow(
        'Code review is not available: missing',
      );
      expect(provisioned).toEqual([]);
    });

    it('throws NotFound when the pull request is gone from the remote', async () => {
      const { svc, provisioned } = harness({
        getPull: () => Promise.resolve(null),
      });
      await expect(svc.pullLatest('f1')).rejects.toThrow(
        'Pull request #12 not found',
      );
      expect(provisioned).toEqual([]);
    });
  });
});
