import { describe, it, expect } from 'vitest';
import { createTaskPlanRunner } from './task-plan-runner.js';
import { featureTasksDefaults } from './config.js';
import type { FeatureTask } from './feature-tasks-contract.js';
import type { FeatureTasksRepo } from './feature-tasks-repo-port.js';
import type { MetaRunner, MetaRequest } from '../meta/meta-runner.js';
import type { FeatureService } from '../feature/feature-service.js';
import { createClock } from '../kernel/clock.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { NotFoundError } from '../kernel/error-types.js';

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
        name: 'Login',
        description: 'Add login',
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: null,
      };
    },
  } as unknown as FeatureService;
}

function fakeMeta(response: string) {
  const requests: MetaRequest[] = [];
  const meta: MetaRunner = {
    run: async (request) => {
      requests.push(request);
      return response;
    },
  };
  return { meta, requests };
}

function build(options: { response: string; seed?: FeatureTask[] }) {
  const repo = inMemoryRepo(options.seed);
  const { meta, requests } = fakeMeta(options.response);
  let counter = 0;
  const runner = createTaskPlanRunner({
    meta,
    features: fakeFeatures(['f1']),
    repo,
    ids: createIdGenerator(() => `t${(counter += 1)}`),
    clock: createClock(() => 0),
    config: featureTasksDefaults,
  });
  return { runner, repo, requests };
}

describe('task-plan-runner', () => {
  it('generates, persists and returns an ordered checklist', async () => {
    const response = JSON.stringify([
      { title: 'First', detail: 'a' },
      { title: 'Second' },
    ]);
    const { runner, repo, requests } = build({ response });

    const tasks = await runner.generate('f1');

    expect(requests[0].featureId).toBe('f1');
    expect(requests[0].prompt).toContain('Login');
    expect(tasks).toEqual([
      {
        id: 't1',
        featureId: 'f1',
        title: 'First',
        detail: 'a',
        status: 'pending',
        position: 0,
        createdAt: '1970-01-01T00:00:00.000Z',
      },
      {
        id: 't2',
        featureId: 'f1',
        title: 'Second',
        detail: '',
        status: 'pending',
        position: 1,
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(repo.listByFeature('f1')).toEqual(tasks);
  });

  it('replaces any existing tasks for the feature', async () => {
    const seed: FeatureTask[] = [
      {
        id: 'old',
        featureId: 'f1',
        title: 'Old task',
        detail: '',
        status: 'done',
        position: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const { runner, repo } = build({
      response: JSON.stringify([{ title: 'Fresh' }]),
      seed,
    });

    await runner.generate('f1');

    expect(repo.get('old')).toBeNull();
    expect(repo.listByFeature('f1').map((t) => t.title)).toEqual(['Fresh']);
  });

  it('persists no tasks when the AI response does not parse', async () => {
    const { runner, repo } = build({ response: 'the model refused' });
    const tasks = await runner.generate('f1');
    expect(tasks).toEqual([]);
    expect(repo.listByFeature('f1')).toEqual([]);
  });

  it('throws when the feature does not exist', async () => {
    const { runner } = build({ response: '[]' });
    await expect(runner.generate('missing')).rejects.toThrow(NotFoundError);
  });
});
