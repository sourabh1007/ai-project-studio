import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createFeatureTasksRepo } from './feature-tasks-repo.js';
import type { FeatureTask } from '../feature-tasks/feature-tasks-contract.js';

function task(overrides: Partial<FeatureTask> = {}): FeatureTask {
  return {
    id: 't1',
    featureId: 'f1',
    title: 'A task',
    detail: 'detail',
    status: 'pending',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('feature-tasks-repo', () => {
  it('creates, reads and lists tasks ordered by position', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureTasksRepo(db);

    repo.create(task({ id: 't2', position: 1, title: 'Second' }));
    repo.create(task({ id: 't1', position: 0, title: 'First' }));
    repo.create(task({ id: 'other', featureId: 'f2', position: 0 }));

    expect(repo.get('t1')).toEqual(task({ id: 't1', position: 0, title: 'First' }));
    expect(repo.get('missing')).toBeNull();
    expect(repo.listByFeature('f1').map((t) => t.id)).toEqual(['t1', 't2']);
    expect(repo.listByFeature('f2').map((t) => t.id)).toEqual(['other']);
  });

  it('updates a task status', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureTasksRepo(db);
    repo.create(task());

    repo.updateStatus('t1', 'done');
    expect(repo.get('t1')?.status).toBe('done');
  });

  it('deletes a single task and all tasks for a feature', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureTasksRepo(db);
    repo.create(task({ id: 't1' }));
    repo.create(task({ id: 't2', position: 1 }));
    repo.create(task({ id: 'keep', featureId: 'f2' }));

    repo.delete('t1');
    expect(repo.get('t1')).toBeNull();

    repo.deleteByFeature('f1');
    expect(repo.listByFeature('f1')).toEqual([]);
    expect(repo.get('keep')).not.toBeNull();
  });

  it('reports the highest position, or -1 when the feature has no tasks', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createFeatureTasksRepo(db);

    expect(repo.maxPosition('f1')).toBe(-1);
    repo.create(task({ id: 't1', position: 0 }));
    repo.create(task({ id: 't2', position: 3 }));
    expect(repo.maxPosition('f1')).toBe(3);
  });
});
