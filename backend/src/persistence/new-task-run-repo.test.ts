import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createNewTaskRunRepo } from './new-task-run-repo.js';
import type { NewTaskRun } from '../new-task/new-task-contract.js';

function run(overrides: Partial<NewTaskRun> = {}): NewTaskRun {
  return {
    id: 'a1',
    featureId: 'f1',
    problem: 'Fix the bug',
    context: 'context here',
    plan: null,
    status: 'draft',
    branch: null,
    prNumber: null,
    prUrl: null,
    reviewFeatureId: null,
    error: null,
    agents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function repo() {
  const db = createDatabase({ databasePath: ':memory:' });
  return { db, repo: createNewTaskRunRepo(db) };
}

describe('new-task-run-repo', () => {
  it('creates and reads back a run', () => {
    const { db, repo: r } = repo();
    r.create(run());
    expect(r.get('a1')).toEqual(run());
    expect(r.get('missing')).toBeNull();
    db.close();
  });

  it('updates every mutable field of a run', () => {
    const { db, repo: r } = repo();
    r.create(run());
    const updated = run({
      problem: 'New problem',
      context: 'new context',
      plan: 'the plan',
      status: 'pr-created',
      branch: 'copilot/new-task-a1',
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      reviewFeatureId: 'rf1',
      error: null,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    r.update(updated);
    expect(r.get('a1')).toEqual(updated);
    db.close();
  });

  it('persists and reads back a non-empty agent roster', () => {
    const { db, repo: r } = repo();
    const agents = [
      {
        id: 'manager',
        parentId: null,
        role: 'manager' as const,
        title: 'Lead agent',
        files: [],
        status: 'done' as const,
        startedAt: null,
        durationMs: 12,
        inputTokens: 3,
        outputTokens: 4,
        credits: null,
      },
    ];
    r.create(run({ agents }));
    expect(r.get('a1')!.agents).toEqual(agents);
    db.close();
  });

  it('tolerates null, corrupt and non-array agents columns', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'n' }));
    r.create(run({ id: 'c' }));
    r.create(run({ id: 'o' }));
    db.exec("UPDATE new_task_runs SET agents = NULL WHERE id = 'n'");
    db.exec("UPDATE new_task_runs SET agents = 'not json' WHERE id = 'c'");
    db.exec("UPDATE new_task_runs SET agents = '{\"a\":1}' WHERE id = 'o'");
    expect(r.get('n')!.agents).toEqual([]);
    expect(r.get('c')!.agents).toEqual([]);
    expect(r.get('o')!.agents).toEqual([]);
    db.close();
  });

  it('defaults a missing agent roster to an empty array on write', () => {
    const { db, repo: r } = repo();
    r.create(run({ agents: undefined as unknown as NewTaskRun['agents'] }));
    expect(r.get('a1')!.agents).toEqual([]);
    r.update(run({ agents: undefined as unknown as NewTaskRun['agents'] }));
    expect(r.get('a1')!.agents).toEqual([]);
    db.close();
  });

  it('deletes a run by id', () => {
    const { db, repo: r } = repo();
    r.create(run());
    r.delete('a1');
    expect(r.get('a1')).toBeNull();
    db.close();
  });

  it('deletes all runs for a feature', () => {
    const { db, repo: r } = repo();
    r.create(run({ id: 'a1', featureId: 'f1' }));
    r.create(run({ id: 'a2', featureId: 'f1' }));
    r.create(run({ id: 'b1', featureId: 'f2' }));
    r.deleteByFeature('f1');
    expect(r.get('a1')).toBeNull();
    expect(r.get('a2')).toBeNull();
    expect(r.get('b1')).not.toBeNull();
    db.close();
  });
});
