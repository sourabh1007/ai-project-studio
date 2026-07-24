import { describe, it, expect } from 'vitest';
import { createFeatureTasksService } from './feature-tasks-service.js';
import { featureTasksDefaults } from './config.js';
import type { FeatureTask } from './feature-tasks-contract.js';
import type { FeatureTasksRepo } from './feature-tasks-repo-port.js';
import type { TaskPlanRunner } from './task-plan-runner.js';
import type { FeatureService } from '../feature/feature-service.js';
import { createClock } from '../kernel/clock.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';

function inMemoryRepo(seed: FeatureTask[] = []): FeatureTasksRepo {
  const tasks = new Map<string, FeatureTask>(seed.map((t) => [t.id, t]));
  return {
    create: (task) => void tasks.set(task.id, task),
    get: (id) => tasks.get(id) ?? null,
    listByFeature: (featureId) =>
      [...tasks.values()]
        .filter((t) => t.featureId === featureId)
        .sort((a, b) => a.position - b.position),
    updateStatus: (id, status) => {
      const t = tasks.get(id);
      if (t) {
        tasks.set(id, { ...t, status });
      }
    },
    delete: (id) => void tasks.delete(id),
    deleteByFeature: (featureId) => {
      for (const [id, t] of tasks) {
        if (t.featureId === featureId) {
          tasks.delete(id);
        }
      }
    },
    maxPosition: (featureId) =>
      [...tasks.values()]
        .filter((t) => t.featureId === featureId)
        .reduce((max, t) => Math.max(max, t.position), -1),
  };
}

function fakeFeatures(ids: string[]): FeatureService {
  const set = new Set(ids);
  return {
    get: (id: string) => {
      if (!set.has(id)) {
        throw new NotFoundError(`Unknown feature: ${id}`);
      }
      return {
        id,
        name: 'F',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
      };
    },
  } as unknown as FeatureService;
}

function build(options: { seed?: FeatureTask[]; generated?: FeatureTask[] } = {}) {
  const repo = inMemoryRepo(options.seed);
  let counter = 0;
  const runnerCalls: string[] = [];
  const runner: TaskPlanRunner = {
    generate: async (featureId) => {
      runnerCalls.push(featureId);
      return options.generated ?? [];
    },
  };
  const service = createFeatureTasksService({
    repo,
    runner,
    features: fakeFeatures(['f1']),
    ids: createIdGenerator(() => `t${(counter += 1)}`),
    clock: createClock(() => 0),
    config: featureTasksDefaults,
  });
  return { service, repo, runnerCalls };
}

function task(overrides: Partial<FeatureTask> = {}): FeatureTask {
  return {
    id: 'x1',
    featureId: 'f1',
    title: 'A task',
    detail: '',
    status: 'pending',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('feature-tasks-service', () => {
  it('lists tasks for an existing feature', () => {
    const { service } = build({ seed: [task()] });
    expect(service.listForFeature('f1')).toEqual([task()]);
  });

  it('throws when listing tasks for an unknown feature', () => {
    const { service } = build();
    expect(() => service.listForFeature('nope')).toThrow(NotFoundError);
  });

  it('delegates generation to the task-plan runner', async () => {
    const generated = [task({ id: 'g1', title: 'Generated' })];
    const { service, runnerCalls } = build({ generated });
    const result = await service.generate('f1');
    expect(result).toEqual(generated);
    expect(runnerCalls).toEqual(['f1']);
  });

  it('adds a manual task at the next position', () => {
    const { service, repo } = build({
      seed: [task({ id: 'x1', position: 0 }), task({ id: 'x2', position: 1 })],
    });
    const created = service.addTask({ featureId: 'f1', title: '  New  ', detail: ' d ' });
    expect(created).toEqual({
      id: 't1',
      featureId: 'f1',
      title: 'New',
      detail: 'd',
      status: 'pending',
      position: 2,
      createdAt: '1970-01-01T00:00:00.000Z',
    });
    expect(repo.get('t1')).toEqual(created);
  });

  it('adds the first task at position zero with an empty detail', () => {
    const { service } = build();
    const created = service.addTask({ featureId: 'f1', title: 'Solo' });
    expect(created.position).toBe(0);
    expect(created.detail).toBe('');
  });

  it('rejects a blank task title', () => {
    const { service } = build();
    expect(() => service.addTask({ featureId: 'f1', title: '   ' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a task title over the configured limit', () => {
    const { service } = build();
    const long = 'a'.repeat(featureTasksDefaults.maxTitleLength + 1);
    expect(() => service.addTask({ featureId: 'f1', title: long })).toThrow(
      ValidationError,
    );
  });

  it('throws when adding to an unknown feature', () => {
    const { service } = build();
    expect(() => service.addTask({ featureId: 'nope', title: 'x' })).toThrow(
      NotFoundError,
    );
  });

  it('toggles a task between pending and done', () => {
    const { service, repo } = build({ seed: [task({ id: 'x1', status: 'pending' })] });
    expect(service.toggle('x1').status).toBe('done');
    expect(repo.get('x1')?.status).toBe('done');
    expect(service.toggle('x1').status).toBe('pending');
  });

  it('throws when toggling an unknown task', () => {
    const { service } = build();
    expect(() => service.toggle('nope')).toThrow(NotFoundError);
  });

  it('removes an existing task', () => {
    const { service, repo } = build({ seed: [task({ id: 'x1' })] });
    service.removeTask('x1');
    expect(repo.get('x1')).toBeNull();
  });

  it('throws when removing an unknown task', () => {
    const { service } = build();
    expect(() => service.removeTask('nope')).toThrow(NotFoundError);
  });
});
