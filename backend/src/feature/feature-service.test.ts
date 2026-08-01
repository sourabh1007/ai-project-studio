import { describe, it, expect } from 'vitest';
import { createFeatureService } from './feature-service.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';
import { AppError } from '../kernel/error-types.js';
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
    delete: (id) => void store.delete(id),
  };
}

function service(repo = inMemoryRepo()) {
  let n = 0;
  return createFeatureService({
    repo,
    ids: createIdGenerator(() => `feat-${(n += 1)}`),
    clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
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
});
