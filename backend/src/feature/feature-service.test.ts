import { describe, it, expect } from 'vitest';
import { createFeatureService } from './feature-service.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';
import { AppError, NotFoundError } from '../kernel/error-types.js';
import type { Feature } from './feature-contract.js';
import type { FeatureRepo } from './feature-repo-port.js';

function inMemoryRepo(): FeatureRepo {
  const store = new Map<string, Feature>();
  return {
    create: (f) => void store.set(f.id, f),
    get: (id) => store.get(id) ?? null,
    list: () => [...store.values()],
    setSummary: (id, summary) => {
      const f = store.get(id);
      if (f) {
        store.set(id, { ...f, summary });
      }
    },
    rename: (id, name) => {
      const f = store.get(id);
      if (f) {
        store.set(id, { ...f, name });
      }
    },
    setCheckoutPath: (id, checkoutPath) => {
      const f = store.get(id);
      if (f) {
        store.set(id, { ...f, checkoutPath });
      }
    },
    updatePlacement: (id, placement) => {
      const f = store.get(id);
      if (f) {
        store.set(id, {
          ...f,
          repoId: placement.repoId,
          parentFeatureId: placement.parentFeatureId,
          parentGroupId: placement.parentGroupId,
          orderIndex: placement.orderIndex,
        });
      }
    },
    delete: (id) => void store.delete(id),
  };
}

/** A repos existence checker that throws for ids not in `known`. */
function repos(known: string[] = []): { get(id: string): unknown } {
  return {
    get: (id: string) => {
      if (!known.includes(id)) {
        throw new NotFoundError(`Unknown repository: ${id}`);
      }
      return { id };
    },
  };
}

/** A group→owning-feature lookup backed by a static id→featureId map. */
function groups(
  map: Record<string, string> = {},
): { get(id: string): { featureId: string } | null } {
  return {
    get: (id: string) =>
      id in map ? { featureId: map[id] } : null,
  };
}

function service(
  repo = inMemoryRepo(),
  known: string[] = ['repo-9', 'repo-1'],
  groupMap: Record<string, string> = {},
) {
  let n = 0;
  return createFeatureService({
    repo,
    ids: createIdGenerator(() => `feat-${(n += 1)}`),
    clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
    repos: repos(known),
    groups: groups(groupMap),
  });
}

describe('feature-service', () => {
  it('creates a feature with generated id and timestamp', () => {
    const svc = service();
    const feature = svc.create({ name: 'Login', description: 'Build login' });
    expect(feature).toEqual({
      id: 'feat-1',
      name: 'Login',
      description: 'Build login',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: null,
      checkoutPath: null,
      parentFeatureId: null,
      parentGroupId: null,
    });
    expect(svc.get('feat-1')).toEqual(feature);
  });

  it('scopes a feature to a repository when a repoId is supplied', () => {
    const svc = service();
    const feature = svc.create({
      name: 'Login',
      description: 'Build login',
      repoId: 'repo-9',
    });
    expect(feature.repoId).toBe('repo-9');
  });

  it('records a checkout path override when supplied', () => {
    const svc = service();
    const feature = svc.create({
      name: 'Review PR #3',
      description: 'https://github.com/a/b/pull/3',
      repoId: 'repo-9',
      checkoutPath: 'C:/wt/app-pr-3',
    });
    expect(feature.checkoutPath).toBe('C:/wt/app-pr-3');
  });

  it('lists created features', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    svc.create({ name: 'B', description: 'b' });
    expect(svc.list().map((f) => f.name)).toEqual(['A', 'B']);
  });

  it('attaches a summary and returns the updated feature', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    const updated = svc.attachSummary('feat-1', 'Done X and Y');
    expect(updated.summary).toBe('Done X and Y');
  });

  it('renames a feature and returns the updated feature', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    const updated = svc.rename('feat-1', 'A2');
    expect(updated.name).toBe('A2');
    expect(svc.get('feat-1').name).toBe('A2');
  });

  it('repoints a feature checkout path and returns the updated feature', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    const updated = svc.setCheckoutPath('feat-1', 'C:/wt/app-pr-9');
    expect(updated.checkoutPath).toBe('C:/wt/app-pr-9');
    expect(svc.get('feat-1').checkoutPath).toBe('C:/wt/app-pr-9');
    expect(() => svc.setCheckoutPath('nope', 'x')).toThrow(AppError);
  });

  it('removes a feature', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    svc.remove('feat-1');
    expect(() => svc.get('feat-1')).toThrow(AppError);
  });

  it('throws NotFound for unknown features', () => {
    const svc = service();
    expect(() => svc.get('nope')).toThrow(AppError);
    expect(() => svc.attachSummary('nope', 'x')).toThrow(AppError);
    expect(() => svc.rename('nope', 'x')).toThrow(AppError);
    expect(() => svc.remove('nope')).toThrow(AppError);
  });

  it('reorders features within the same repository group', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    svc.create({ name: 'B', description: 'b', repoId: 'repo-9' });
    svc.create({ name: 'C', description: 'c', repoId: 'repo-9' });
    // Move C (feat-3) to the front.
    svc.moveFeature({ id: 'feat-3', targetRepoId: 'repo-9', targetIndex: 0 });
    const ordered = [...svc.list()].sort(
      (l, r) => (l.orderIndex ?? 0) - (r.orderIndex ?? 0),
    );
    expect(ordered.map((f) => f.id)).toEqual(['feat-3', 'feat-1', 'feat-2']);
    expect(ordered.map((f) => f.orderIndex)).toEqual([0, 1, 2]);
  });

  it('moves a feature into a different repository group', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    svc.create({ name: 'B', description: 'b', repoId: 'repo-1' });
    svc.moveFeature({ id: 'feat-1', targetRepoId: 'repo-1', targetIndex: 0 });
    expect(svc.get('feat-1').repoId).toBe('repo-1');
    expect(svc.get('feat-1').orderIndex).toBe(0);
    expect(svc.get('feat-2').orderIndex).toBe(1);
  });

  it('moves a feature into the repo-less group without validating a repo', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, []);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    svc.moveFeature({ id: 'feat-1', targetRepoId: null, targetIndex: 5 });
    expect(svc.get('feat-1').repoId).toBeNull();
    expect(svc.get('feat-1').orderIndex).toBe(0);
  });

  it('rejects moving into an unknown repository group', () => {
    const svc = service();
    svc.create({ name: 'A', description: 'a' });
    expect(() =>
      svc.moveFeature({ id: 'feat-1', targetRepoId: 'ghost', targetIndex: 0 }),
    ).toThrow(AppError);
  });

  it('rejects moving an unknown feature', () => {
    const svc = service();
    expect(() =>
      svc.moveFeature({ id: 'nope', targetRepoId: null, targetIndex: 0 }),
    ).toThrow(AppError);
  });

  it('orders existing siblings by index when moving one in', () => {
    const repo = inMemoryRepo();
    const seed = (over: Partial<Feature>): void =>
      repo.create({
        id: 'x',
        name: 'X',
        description: '',
        createdAt: '2025-01-01T00:00:00.000Z',
        summary: null,
        repoId: 'repo-9',
        checkoutPath: null,
        orderIndex: 0,
        ...over,
      });
    seed({ id: 'hi', orderIndex: 1 });
    seed({ id: 'lo', orderIndex: 0 });
    seed({ id: 'ext', repoId: null });
    const svc = service(repo);
    svc.moveFeature({ id: 'ext', targetRepoId: 'repo-9', targetIndex: 1 });
    const ordered = svc
      .list()
      .filter((f) => f.repoId === 'repo-9')
      .sort((l, r) => (l.orderIndex ?? 0) - (r.orderIndex ?? 0));
    expect(ordered.map((f) => f.id)).toEqual(['lo', 'ext', 'hi']);
  });

  it('breaks index ties by creation time, then id, when moving', () => {
    const repo = inMemoryRepo();
    const seed = (over: Partial<Feature>): void =>
      repo.create({
        id: 'x',
        name: 'X',
        description: '',
        createdAt: '2025-01-01T00:00:00.000Z',
        summary: null,
        repoId: 'repo-9',
        checkoutPath: null,
        orderIndex: 0,
        ...over,
      });
    seed({ id: 'later', createdAt: '2025-02-01T00:00:00.000Z' });
    seed({ id: 'aaa', createdAt: '2025-01-01T00:00:00.000Z' });
    seed({ id: 'bbb', createdAt: '2025-01-01T00:00:00.000Z' });
    seed({ id: 'ext', repoId: null });
    const svc = service(repo);
    svc.moveFeature({ id: 'ext', targetRepoId: 'repo-9', targetIndex: 3 });
    const ordered = svc
      .list()
      .filter((f) => f.repoId === 'repo-9')
      .sort((l, r) => (l.orderIndex ?? 0) - (r.orderIndex ?? 0));
    expect(ordered.map((f) => f.id)).toEqual(['aaa', 'bbb', 'later', 'ext']);
  });

  it('nests a feature under a parent and inherits the parent repo', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'Parent', description: 'p', repoId: 'repo-9' });
    svc.create({ name: 'Child', description: 'c' }); // repo-less, top-level
    svc.moveFeature({
      id: 'feat-2',
      targetRepoId: null,
      targetIndex: 0,
      targetParentFeatureId: 'feat-1',
    });
    const child = svc.get('feat-2');
    expect(child.parentFeatureId).toBe('feat-1');
    expect(child.repoId).toBe('repo-9');
    expect(child.orderIndex).toBe(0);
  });

  it('nests under a repo-less parent, inheriting a null repo', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'Parent', description: 'p' }); // repo-less, top-level
    svc.create({ name: 'Child', description: 'c', repoId: 'repo-9' });
    svc.moveFeature({
      id: 'feat-2',
      targetRepoId: 'repo-9',
      targetIndex: 0,
      targetParentFeatureId: 'feat-1',
    });
    const child = svc.get('feat-2');
    expect(child.parentFeatureId).toBe('feat-1');
    expect(child.repoId).toBeNull();
  });

  it('reorders a feature among its parent\'s existing children', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'Parent', description: 'p', repoId: 'repo-9' });
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    svc.create({ name: 'B', description: 'b', repoId: 'repo-9' });
    // Nest both A and B under the parent, then move B ahead of A.
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-1' });
    svc.moveFeature({ id: 'feat-3', targetRepoId: 'repo-9', targetIndex: 1, targetParentFeatureId: 'feat-1' });
    svc.moveFeature({ id: 'feat-3', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-1' });
    const children = svc
      .list()
      .filter((f) => f.parentFeatureId === 'feat-1')
      .sort((l, r) => (l.orderIndex ?? 0) - (r.orderIndex ?? 0));
    expect(children.map((f) => f.id)).toEqual(['feat-3', 'feat-2']);
  });

  it('un-nests a feature back to the top level', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'Parent', description: 'p', repoId: 'repo-9' });
    svc.create({ name: 'Child', description: 'c', repoId: 'repo-9' });
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-1' });
    expect(svc.get('feat-2').parentFeatureId).toBe('feat-1');
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0 });
    expect(svc.get('feat-2').parentFeatureId).toBeNull();
  });

  it('rejects nesting a feature under itself', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentFeatureId: 'feat-1',
      }),
    ).toThrow(AppError);
  });

  it('rejects nesting a feature under one of its own descendants', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' }); // feat-1
    svc.create({ name: 'B', description: 'b', repoId: 'repo-9' }); // feat-2
    svc.create({ name: 'C', description: 'c', repoId: 'repo-9' }); // feat-3
    // B under A, then C under B → A's descendants are B and C.
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-1' });
    svc.moveFeature({ id: 'feat-3', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-2' });
    // Nesting A under C (its grandchild) must be rejected.
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentFeatureId: 'feat-3',
      }),
    ).toThrow(AppError);
  });

  it('rejects nesting under an unknown parent feature', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentFeatureId: 'ghost',
      }),
    ).toThrow(AppError);
  });

  it('inherits a null repo when the group owner is repo-less', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9'], { 'grp-1': 'feat-1' });
    svc.create({ name: 'Owner', description: 'o' }); // feat-1, repo-less
    svc.create({ name: 'Mover', description: 'm', repoId: 'repo-9' }); // feat-2
    svc.moveFeature({
      id: 'feat-2',
      targetRepoId: 'repo-9',
      targetIndex: 0,
      targetParentGroupId: 'grp-1',
    });
    const moved = svc.get('feat-2');
    expect(moved.parentGroupId).toBe('grp-1');
    expect(moved.repoId).toBeNull();
  });

  it('creates a feature inside a subcategory group', () => {
    const svc = service(inMemoryRepo(), ['repo-9'], { 'grp-1': 'feat-owner' });
    const feature = svc.create({
      name: 'Inside',
      description: 'in a folder',
      repoId: 'repo-9',
      parentGroupId: 'grp-1',
    });
    expect(feature.parentGroupId).toBe('grp-1');
  });

  it('places a feature into a subcategory group, inheriting the owner repo', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9', 'repo-1'], { 'grp-1': 'feat-1' });
    svc.create({ name: 'Owner', description: 'o', repoId: 'repo-9' }); // feat-1
    svc.create({ name: 'Mover', description: 'm', repoId: 'repo-1' }); // feat-2
    svc.moveFeature({
      id: 'feat-2',
      targetRepoId: 'repo-1',
      targetIndex: 0,
      targetParentGroupId: 'grp-1',
    });
    const moved = svc.get('feat-2');
    expect(moved.parentGroupId).toBe('grp-1');
    expect(moved.parentFeatureId).toBeNull();
    expect(moved.repoId).toBe('repo-9');
    expect(moved.orderIndex).toBe(0);
  });

  it('reorders features within a subcategory group', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9'], { 'grp-1': 'feat-1' });
    svc.create({ name: 'Owner', description: 'o', repoId: 'repo-9' }); // feat-1
    svc.create({ name: 'A', description: 'a' }); // feat-2
    svc.create({ name: 'B', description: 'b' }); // feat-3
    svc.moveFeature({ id: 'feat-2', targetRepoId: null, targetIndex: 0, targetParentGroupId: 'grp-1' });
    svc.moveFeature({ id: 'feat-3', targetRepoId: null, targetIndex: 1, targetParentGroupId: 'grp-1' });
    svc.moveFeature({ id: 'feat-3', targetRepoId: null, targetIndex: 0, targetParentGroupId: 'grp-1' });
    const members = svc
      .list()
      .filter((f) => f.parentGroupId === 'grp-1')
      .sort((l, r) => (l.orderIndex ?? 0) - (r.orderIndex ?? 0));
    expect(members.map((f) => f.id)).toEqual(['feat-3', 'feat-2']);
  });

  it('un-nests a feature out of a subcategory group', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9'], { 'grp-1': 'feat-1' });
    svc.create({ name: 'Owner', description: 'o', repoId: 'repo-9' });
    svc.create({ name: 'Mover', description: 'm' });
    svc.moveFeature({ id: 'feat-2', targetRepoId: null, targetIndex: 0, targetParentGroupId: 'grp-1' });
    expect(svc.get('feat-2').parentGroupId).toBe('grp-1');
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0 });
    expect(svc.get('feat-2').parentGroupId).toBeNull();
    expect(svc.get('feat-2').repoId).toBe('repo-9');
  });

  it('rejects placing a feature into an unknown group', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentGroupId: 'ghost',
      }),
    ).toThrow(AppError);
  });

  it('rejects placing a feature into a group it owns', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9'], { 'grp-1': 'feat-1' });
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' });
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentGroupId: 'grp-1',
      }),
    ).toThrow(AppError);
  });

  it('rejects placing a feature into a group owned by its descendant', () => {
    const repo = inMemoryRepo();
    // grp-1 is owned by feat-2, which we nest under feat-1.
    const svc = service(repo, ['repo-9'], { 'grp-1': 'feat-2' });
    svc.create({ name: 'A', description: 'a', repoId: 'repo-9' }); // feat-1
    svc.create({ name: 'B', description: 'b', repoId: 'repo-9' }); // feat-2
    svc.moveFeature({ id: 'feat-2', targetRepoId: 'repo-9', targetIndex: 0, targetParentFeatureId: 'feat-1' });
    expect(() =>
      svc.moveFeature({
        id: 'feat-1',
        targetRepoId: 'repo-9',
        targetIndex: 0,
        targetParentGroupId: 'grp-1',
      }),
    ).toThrow(AppError);
  });

  it('tolerates a dangling group ancestor when checking for cycles', () => {
    const repo = inMemoryRepo();
    const svc = service(repo, ['repo-9'], { 'grp-1': 'owner', 'grp-x': 'ghost' });
    // The group owner points at a group whose owning feature no longer exists;
    // the cycle walk must break rather than throw.
    repo.create({
      id: 'owner',
      name: 'Owner',
      description: 'o',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: 'repo-9',
      checkoutPath: null,
      parentFeatureId: null,
      parentGroupId: 'grp-x',
      orderIndex: 0,
    });
    repo.create({
      id: 'mover',
      name: 'Mover',
      description: 'm',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: null,
      checkoutPath: null,
      parentFeatureId: null,
      parentGroupId: null,
      orderIndex: 0,
    });
    svc.moveFeature({
      id: 'mover',
      targetRepoId: null,
      targetIndex: 0,
      targetParentGroupId: 'grp-1',
    });
    expect(svc.get('mover').parentGroupId).toBe('grp-1');
    expect(svc.get('mover').repoId).toBe('repo-9');
  });

  it('stops the cycle walk when a group ancestor no longer resolves', () => {
    const repo = inMemoryRepo();
    // grp-1 is owned by owner2, whose parentGroupId points at a group that is
    // not in the lookup, so resolving the next ancestor yields null.
    const svc = service(repo, ['repo-9'], { 'grp-1': 'owner2' });
    repo.create({
      id: 'owner2',
      name: 'Owner2',
      description: 'o',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: 'repo-9',
      checkoutPath: null,
      parentFeatureId: null,
      parentGroupId: 'grp-missing',
      orderIndex: 0,
    });
    repo.create({
      id: 'mover',
      name: 'Mover',
      description: 'm',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: null,
      checkoutPath: null,
      parentFeatureId: null,
      parentGroupId: null,
      orderIndex: 0,
    });
    svc.moveFeature({
      id: 'mover',
      targetRepoId: null,
      targetIndex: 0,
      targetParentGroupId: 'grp-1',
    });
    expect(svc.get('mover').parentGroupId).toBe('grp-1');
  });
});
