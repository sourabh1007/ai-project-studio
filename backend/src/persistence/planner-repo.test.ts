import { describe, it, expect } from 'vitest';
import { createDatabase } from './db/connection.js';
import { createPlannerRepo } from './planner-repo.js';
import type { PlannerTask } from '../planner/planner-contract.js';

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 't1',
    title: 'A task',
    notes: 'notes',
    priority: 'p2',
    status: 'open',
    kind: 'task',
    prUrl: '',
    date: '2026-02-10',
    repoId: null,
    launchKind: null,
    featureId: null,
    sessionId: null,
    launchLabel: null,
    backloggedAt: null,
    createdAt: '2026-02-10T08:00:00.000Z',
    updatedAt: '2026-02-10T08:00:00.000Z',
    ...overrides,
  };
}

describe('planner-repo', () => {
  it('creates, reads and lists tasks newest date first', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createPlannerRepo(db);

    repo.create(task({ id: 'old', date: '2025-01-01' }));
    repo.create(task({ id: 'new', date: '2026-05-05' }));
    repo.create(
      task({
        id: 'pr',
        kind: 'pr',
        prUrl: 'https://github.com/o/r/pull/9',
        date: '2026-05-05',
        createdAt: '2026-05-05T10:00:00.000Z',
      }),
    );

    expect(repo.get('old')).toEqual(task({ id: 'old', date: '2025-01-01' }));
    expect(repo.get('missing')).toBeNull();
    // Same date => most recently created first (pr created after new).
    expect(repo.list().map((t) => t.id)).toEqual(['pr', 'new', 'old']);
  });

  it('updates all mutable fields', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createPlannerRepo(db);
    repo.create(task());

    repo.update(
      task({
        title: 'changed',
        notes: 'new notes',
        priority: 'p0',
        status: 'done',
        kind: 'pr',
        prUrl: 'https://x/pull/1',
        date: '2024-12-31',
        repoId: 'repo-1',
        launchKind: 'session',
        featureId: 'feat-1',
        sessionId: 'sess-1',
        launchLabel: 'Fix the bug',
        backloggedAt: '2026-02-09',
        updatedAt: '2026-02-11T08:00:00.000Z',
      }),
    );

    expect(repo.get('t1')).toEqual(
      task({
        title: 'changed',
        notes: 'new notes',
        priority: 'p0',
        status: 'done',
        kind: 'pr',
        prUrl: 'https://x/pull/1',
        date: '2024-12-31',
        repoId: 'repo-1',
        launchKind: 'session',
        featureId: 'feat-1',
        sessionId: 'sess-1',
        launchLabel: 'Fix the bug',
        backloggedAt: '2026-02-09',
        updatedAt: '2026-02-11T08:00:00.000Z',
      }),
    );
  });

  it('round-trips the launch fields on create', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createPlannerRepo(db);
    repo.create(
      task({
        repoId: 'r1',
        launchKind: 'review',
        featureId: 'f1',
        sessionId: null,
        launchLabel: 'Review PR #9',
      }),
    );
    expect(repo.get('t1')).toEqual(
      task({
        repoId: 'r1',
        launchKind: 'review',
        featureId: 'f1',
        sessionId: null,
        launchLabel: 'Review PR #9',
      }),
    );
  });

  it('deletes a task', () => {
    const db = createDatabase({ databasePath: ':memory:' });
    const repo = createPlannerRepo(db);
    repo.create(task());
    repo.delete('t1');
    expect(repo.get('t1')).toBeNull();
  });
});
