import { describe, expect, it } from 'vitest';
import type { PlannerTask } from '../planner/planner-contract.js';
import { scopeRange, tasksInScope } from './planner-summary-range.js';

function task(partial: Partial<PlannerTask>): PlannerTask {
  return {
    id: 'id',
    title: 'Task',
    notes: '',
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
    createdAt: '2026-02-10T00:00:00.000Z',
    updatedAt: '2026-02-10T00:00:00.000Z',
    ...partial,
  };
}

describe('scopeRange', () => {
  it('returns the full day for a day scope', () => {
    expect(scopeRange('day', '2026-02-10')).toBe('2026-02-10');
  });

  it('returns the YYYY-MM month for a month scope', () => {
    expect(scopeRange('month', '2026-02-10')).toBe('2026-02');
  });

  it('returns the YYYY year for a year scope', () => {
    expect(scopeRange('year', '2026-02-10')).toBe('2026');
  });
});

describe('tasksInScope', () => {
  const tasks = [
    task({ id: 'a', date: '2026-02-10', createdAt: '2026-02-10T09:00:00Z' }),
    task({ id: 'b', date: '2026-02-10', createdAt: '2026-02-10T08:00:00Z' }),
    task({ id: 'c', date: '2026-02-20' }),
    task({ id: 'd', date: '2026-03-01' }),
    task({ id: 'e', date: '2025-12-31' }),
  ];

  it('filters to a single day and sorts by date then creation order', () => {
    expect(tasksInScope(tasks, 'day', '2026-02-10').map((t) => t.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('filters to a month', () => {
    expect(tasksInScope(tasks, 'month', '2026-02-10').map((t) => t.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('filters to a year', () => {
    expect(tasksInScope(tasks, 'year', '2026-07-01').map((t) => t.id)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
  });
});
