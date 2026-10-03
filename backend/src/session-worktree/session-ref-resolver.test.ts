import { describe, it, expect } from 'vitest';
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
  overrides: Partial<SessionRefResolverDeps> & {
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
  it('returns null for a repo-less feature', async () => {
    const resolver = harness({ feature: feature({ repoId: null }) });
    expect(await resolver.resolve('f1')).toBeNull();
  });

  it('returns null when the feature does not exist', async () => {
    const resolver = harness({ feature: null });
    expect(await resolver.resolve('f1')).toBeNull();
  });

  it('returns null when the repository is missing', async () => {
    const resolver = harness({ repo: null });
    expect(await resolver.resolve('f1')).toBeNull();
  });

  it('starts non-PR sessions on master even when another repo default is configured', async () => {
    const resolver = harness({ repo: repo({ defaultBranch: 'trunk' }) });
    expect(await resolver.resolve('f1')).toEqual({
      repoLocalPath: 'C:\\src\\app',
      ref: 'master',
    });
  });

  it('falls back to master when the repository has no default branch', async () => {
    const resolver = harness({ repo: repo({ defaultBranch: null }) });
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
    expect((await createSessionRefResolver(deps).resolve('f1'))?.ref).toBe('master');
    await expect(createSessionRefResolver({
      ...deps, isPrFeature: () => true, getFeature: () => feature(),
    }).resolve('f1')).rejects.toThrow('PR checkout is unavailable');
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

  it('falls back to master when a legacy PR source branch is unknown', async () => {
    const resolver = harness({
      feature: feature({ checkoutPath: 'C:\\wt\\pr-7' }),
      branch: null,
    });
    expect(await resolver.resolve('f1')).toEqual({
      repoLocalPath: 'C:\\src\\app',
      ref: FALLBACK_DEFAULT_BRANCH,
      checkoutPath: 'C:\\wt\\pr-7',
    });
  });
});
