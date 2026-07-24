import { describe, expect, it } from 'vitest';
import { taskProgress, hasTaskPlanSkill } from './task-progress.js';
import type { FeatureTask } from './types.js';

function task(overrides: Partial<FeatureTask> = {}): FeatureTask {
  return {
    id: 't1',
    featureId: 'f1',
    title: 'A task',
    detail: '',
    status: 'pending',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('taskProgress', () => {
  it('reports zero progress for an empty checklist', () => {
    expect(taskProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it('counts done tasks and rounds the percentage', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'pending' }),
      task({ id: 'c', status: 'done' }),
    ];
    expect(taskProgress(tasks)).toEqual({ done: 2, total: 3, percent: 67 });
  });

  it('reports full completion', () => {
    expect(taskProgress([task({ status: 'done' })])).toEqual({
      done: 1,
      total: 1,
      percent: 100,
    });
  });
});

describe('hasTaskPlanSkill', () => {
  it('is true when a task-plan skill is present', () => {
    expect(
      hasTaskPlanSkill([{ kind: 'instruction' }, { kind: 'task-plan' }]),
    ).toBe(true);
  });

  it('is false when only other skill kinds are present', () => {
    expect(hasTaskPlanSkill([{ kind: 'instruction' }])).toBe(false);
    expect(hasTaskPlanSkill([])).toBe(false);
  });
});
