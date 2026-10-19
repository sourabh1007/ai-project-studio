import { describe, it, expect, vi } from 'vitest';
import {
  createSessionRefResolver,
  FALLBACK_DEFAULT_BRANCH,
  type SessionRefResolverDeps,
} from './session-ref-resolver.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Repository } from '../repo/repo-contract.js';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f1',
    name: 'Feature',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: null,
    repoId: 'r1',
    checkoutPath: null,
    ...overrides,
  };
}

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 'r1',
    name: 'app',
    provider: 'github',
    remoteUrl: 'https://example/app.git',
    localPath: 'C:\\src\\app',
    defaultBranch: 'main',
    ...overrides,
  } as Repository;
}

function harness(
  overrides: Partial<Omit<SessionRefResolverDeps, 'branch'>> & {
    feature?: Feature | null;
    repo?: Repository | null;
    branch?: string | null;
  } = {},
) {
  const deps: SessionRefResolverDeps = {
    getFeature: () =>
      overrides.feature === undefined ? feature() : overrides.feature,
    getRepo: () => (overrides.repo === undefined ? repo() : overrides.repo),
    branch: {
      read: async () =>
        overrides.branch === undefined ? null : overrides.branch,
    },
  };
  return createSessionRefResolver(deps);
}

describe('createSessionRefResolver', () => {
  it.each([
    { saved: { path: 'C:\\saved', ref: 'original' }, repository: repo(), expected: 'original' },
    { saved: { path: 'C:\\saved' }, repository: repo(), expected: 'main' },
    { saved: { path: 'C:\\saved' }, repository: repo({ defaultBranch: '' }), expected: 'master' },
    { saved: { path: 'C:\\saved' }, repository: repo({ defaultBranch: undefined }), expected: 'master' },
  ])('restores a recorded checkout without requiring a surviving task or PR attachment ($expected)', async ({ saved, repository, expected }) => {
    const select = vi.fn(async () => null);
    const resolver = createSessionRefResolver({
      getFeature: () => feature(), getRepo: () => repository,
      isPrFeature: () => true, branch: { read: async () => null },
    });
    expect(await resolver.resolve('f1', select, saved)).toEqual({
      repoLocalPath: repository.localPath, checkoutPath: saved.path, ref: expected,
    });
    expect(select).not.toHaveBeenCalled();
  });
  it('reuses a task worktree and branch, without creating per-session copies', async () => {
    const task = { id: 'task', checkoutPath: 'C:\\task', ref: 'users/me/task' };
    const resolver = createSessionRefResolver({
      getFeature: () => feature(), getRepo: () => repo(),
      branch: { read: async () => null },
      getTaskCheckouts: () => [task],
    });
    expect(await resolver.resolve('f1')).toEqual({ repoLocalPath: 'C:\\src\\app', checkoutPath: task.checkoutPath, ref: task.ref, bindSession: true });
    expect(resolver.choices('f1')).toEqual([task]);
    expect(resolver.resolveCwd('f1')).toBe('C:\\task');
  });

  it('keeps PR checkout priority, uses the default before a task has a branch, and rejects ambiguous task worktrees', async () => {
    const deps: SessionRefResolverDeps = {
      getFeature: () => feature(), getRepo: () => repo(), isPrFeature: () => false,
      branch: { read: async () => null }, getTaskCheckouts: () => [],
    };
    expect((await createSessionRefResolver(deps).resolve('f1'))?.ref).toBe('main');
    expect(createSessionRefResolver(deps).resolveCwd('f1')).toBe('C:\\src\\app');
    const tasks = () => [{ id: 't1', checkoutPath: 'C:\\task1', ref: 'task1' }, { id: 't2', checkoutPath: 'C:\\task2', ref: 'task2' }];
    await expect(createSessionRefResolver({ ...deps, getTaskCheckouts: tasks }).resolve('f1')).rejects.toThrow('multiple task worktrees');
    expect(() => createSessionRefResolver({ ...deps, getTaskCheckouts: tasks }).resolveCwd('f1')).toThrow('multiple task worktrees');
    expect(await createSessionRefResolver({
      ...deps, getFeature: () => feature({ checkoutPath: 'C:\\pr' }), isPrFeature: () => true,
      getPrBranch: () => 'pr-source', getTaskCheckouts: tasks,
    }).resolve('f1')).toEqual({ repoLocalPath: 'C:\\src\\app', ref: 'pr-source', checkoutPath: 'C:\\pr' });
    expect(harness({ feature: feature({ checkoutPath: 'C:\\pr' }) }).resolveCwd('f1')).toBe('C:\\pr');
  });
  it('validates API choice IDs and asks interactive launches without choosing a task automatically', async () => {
    const tasks = [{ id: 't1', checkoutPath: 'C:\\task1', ref: 'task1' }, { id: 't2', checkoutPath: 'C:\\task2', ref: 'task2' }];
    const resolver = createSessionRefResolver({
      getFeature: () => feature(), getRepo: () => repo(), branch: { read: async () => null },
      getTaskCheckouts: () => tasks,
    });
    expect(resolver.resolveCwd('f1', 't2')).toBe('C:\\task2');
    expect(() => resolver.resolveCwd('f1', 'C:\\arbitrary')).toThrow('no longer available');
    const select = vi.fn(async () => 't2');
    expect(await resolver.resolve('f1', select)).toEqual({
      repoLocalPath: 'C:\\src\\app', checkoutPath: 'C:\\task2', ref: 'task2', bindSession: true,
    });
    expect(select).toHaveBeenCalledWith(tasks);
    await expect(resolver.resolve('f1', async () => null)).rejects.toThrow('cancelled');
    await expect(resolver.resolve('f1', async () => 'arbitrary')).rejects.toThrow('no longer available');
  });
  it.each(['removed', 'path', 'branch', 'feature', 'pr'] as const)('rejects a %s change while choosing', async (change) => {
    let tasks = [{ id: 't1', checkoutPath: 'C:\\task1', ref: 'task1' }, { id: 't2', checkoutPath: 'C:\\task2', ref: 'task2' }];
    let currentFeature: Feature | null = feature();
    let isPr = false;
    const resolver = createSessionRefResolver({
      getFeature: () => currentFeature, getRepo: () => repo(), isPrFeature: () => isPr,
      branch: { read: async () => null }, getTaskCheckouts: () => tasks,
    });
    await expect(resolver.resolve('f1', async () => {
      if (change === 'removed') tasks = [];
      if (change === 'path') tasks = [{ ...tasks[0], checkoutPath: 'C:\\moved' }];
      if (change === 'branch') tasks = [{ ...tasks[0], ref: 'new-plan' }];
      if (change === 'feature') currentFeature = null;
      if (change === 'pr') isPr = true;
      return 't1';
    })).rejects.toThrow(/changed|no longer available/);
  });
  it('lists no choices for PRs, missing features/repositories, or unplanned features', () => {
    expect(harness({ feature: null }).choices('f1')).toEqual([]);
    expect(harness({ feature: feature({ repoId: null }) }).choices('f1')).toEqual([]);
    expect(harness({ feature: feature({ checkoutPath: 'C:\\pr' }) }).choices('f1')).toEqual([]);
    expect(harness({ repo: null }).choices('f1')).toEqual([]);
    expect(harness().choices('f1')).toEqual([]);
    expect(createSessionRefResolver({
      getFeature: () => feature(), getRepo: () => repo(), isPrFeature: () => true,
      branch: { read: async () => null },
    }).choices('f1')).toEqual([]);
  });
  it('returns null for a repo-less feature', async () => {
    const resolver = harness({ feature: feature({ repoId: null }) });
    expect(await resolver.resolve('f1')).toBeNull();
    expect(resolver.resolveCwd('f1')).toBeUndefined();
  });

  it('returns null when the feature does not exist', async () => {
    const resolver = harness({ feature: null });
    expect(await resolver.resolve('f1')).toBeNull();
    expect(resolver.resolveCwd('f1')).toBeUndefined();
  });

  it('returns null when the repository is missing', async () => {
    const resolver = harness({ repo: null });
    expect(await resolver.resolve('f1')).toBeNull();
    expect(resolver.resolveCwd('f1')).toBeUndefined();
  });

  it('starts non-PR sessions on the repository default branch', async () => {
    const resolver = harness({ repo: repo({ defaultBranch: 'trunk' }) });
    expect(await resolver.resolve('f1')).toEqual({
      repoLocalPath: 'C:\\src\\app',
      ref: 'trunk',
    });
    expect(resolver.resolveCwd('f1')).toBe('C:\\src\\app');
  });

  it('falls back to master when the repository has no default branch', async () => {
    const resolver = harness({ repo: repo({ defaultBranch: null }) });
    expect((await resolver.resolve('f1'))?.ref).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  it('falls back to master when the repository default branch is blank', async () => {
    const resolver = harness({ repo: repo({ defaultBranch: '   ' }) });
    expect((await resolver.resolve('f1'))?.ref).toBe(FALLBACK_DEFAULT_BRANCH);
  });
  it('uses the PR source branch even if its review checkout switched branches', async () => {
    const resolver = createSessionRefResolver({
      getFeature: () => feature({ checkoutPath: 'C:\\pr' }),
      getRepo: () => repo(),
      getPrBranch: () => 'users/me/pr-source',
      branch: { read: async () => 'unrelated-review-branch' },
    });
    expect((await resolver.resolve('f1'))?.ref).toBe('users/me/pr-source');
    const plain = createSessionRefResolver({
      getFeature: () => feature(), getRepo: () => repo({ defaultBranch: 'master' }),
      getPrBranch: () => null, branch: { read: async () => null },
    });
    expect((await plain.resolve('f1'))?.ref).toBe('master');
  });
  it('ignores non-PR feature checkout branches and falls back for unknown PR sources', async () => {
    const deps: SessionRefResolverDeps = {
      getFeature: () => feature({ checkoutPath: 'C:\\task-copy' }), getRepo: () => repo(),
      getPrBranch: () => null, isPrFeature: () => false,
      branch: { read: async () => 'generated-task-branch' },
    };
    expect((await createSessionRefResolver(deps).resolve('f1'))?.ref).toBe('main');
    await expect(createSessionRefResolver({
      ...deps, isPrFeature: () => true, getFeature: () => feature(),
    }).resolve('f1')).rejects.toThrow('PR checkout is unavailable');
    expect(() => createSessionRefResolver({
      ...deps, isPrFeature: () => true, getFeature: () => feature(),
    }).resolveCwd('f1')).toThrow('PR checkout is unavailable');
    await expect(createSessionRefResolver({
      ...deps, isPrFeature: () => true, getFeature: () => feature(), getPrBranch: () => 'users/me/pr',
    }).resolve('f1')).rejects.toThrow('PR checkout is unavailable');
  });

  it('defaults a PR feature to the branch checked out in its worktree', async () => {
    const resolver = harness({
      feature: feature({ checkoutPath: 'C:\\wt\\pr-7' }),
      branch: 'users/me/fix',
    });
    expect((await resolver.resolve('f1'))?.ref).toBe('users/me/fix');
  });

  it('falls back to the repository default branch when a legacy PR source branch is unknown', async () => {
    const resolver = harness({
      feature: feature({ checkoutPath: 'C:\\wt\\pr-7' }),
      branch: null,
    });
    expect(await resolver.resolve('f1')).toEqual({
      repoLocalPath: 'C:\\src\\app',
      ref: 'main',
      checkoutPath: 'C:\\wt\\pr-7',
    });
  });
});
