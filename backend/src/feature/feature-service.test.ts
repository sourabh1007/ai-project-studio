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
    updatePlacement: (id, placement) => {
      const f = store.get(id);
      if (f) {
        store.set(id, {
          ...f,
          repoId: placement.repoId,
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

function service(repo = inMemoryRepo(), known: string[] = ['repo-9', 'repo-1']) {
  let n = 0;
  return createFeatureService({
    repo,
    ids: createIdGenerator(() => `feat-${(n += 1)}`),
    clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
    repos: repos(known),
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

  it('seeds a default Scratchpad feature when the workspace is empty', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.ensureScratchpad();
    const all = svc.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      id: 'feat-1',
      name: 'Scratchpad',
      description:
        'Quick, ad-hoc CLI runs. Start a session here without setting up a feature first.',
      createdAt: '2025-01-01T00:00:00.000Z',
      summary: null,
      repoId: null,
      checkoutPath: null,
      parentFeatureId: null,
    });
  });

  it('does not seed a Scratchpad when a feature already exists', () => {
    const repo = inMemoryRepo();
    const svc = service(repo);
    svc.create({ name: 'Login', description: 'Build login' });
    svc.ensureScratchpad();
    const all = svc.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('Login');
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
});
