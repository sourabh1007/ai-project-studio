import { describe, it, expect, beforeEach } from 'vitest';
import { createPlannerService, type PlannerService } from './planner-service.js';
import { plannerDefaults } from './config.js';
import type { PlannerTask } from './planner-contract.js';
import type { PlannerRepo } from './planner-repo-port.js';
import { createClock } from '../kernel/clock.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';

function inMemoryRepo(seed: PlannerTask[] = []): PlannerRepo {
  const tasks = new Map<string, PlannerTask>(seed.map((t) => [t.id, t]));
  return {
    create: (task) => void tasks.set(task.id, task),
    get: (id) => tasks.get(id) ?? null,
    list: () =>
      [...tasks.values()].sort((a, b) =>
        a.date === b.date
          ? b.createdAt.localeCompare(a.createdAt)
          : b.date.localeCompare(a.date),
      ),
    update: (task) => void tasks.set(task.id, task),
    delete: (id) => void tasks.delete(id),
  };
}

function makeService(options?: {
  repo?: PlannerRepo;
  times?: string[];
  ids?: string[];
}): { service: PlannerService; repo: PlannerRepo } {
  const repo = options?.repo ?? inMemoryRepo();
  const times = [...(options?.times ?? ['2026-02-10T08:00:00.000Z'])];
  const ids = [...(options?.ids ?? ['id-1', 'id-2', 'id-3'])];
  const service = createPlannerService({
    repo,
    ids: createIdGenerator(() => ids.shift() ?? 'id-x'),
    clock: createClock(() => new Date(times.shift() ?? times[0] ?? '2026-02-10T08:00:00.000Z').getTime()),
    config: plannerDefaults,
  });
  return { service, repo };
}

describe('planner service create', () => {
  it('creates a task with defaults derived from config and the clock day', () => {
    const { service } = makeService({ ids: ['t1'] });
    const task = service.create({ title: '  Ship it  ' });
    expect(task).toMatchObject({
      id: 't1',
      title: 'Ship it',
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
    });
    expect(task.createdAt).toBe('2026-02-10T08:00:00.000Z');
    expect(task.updatedAt).toBe('2026-02-10T08:00:00.000Z');
  });

  it('stores a chosen repository and blanks whitespace-only repo ids', () => {
    const { service } = makeService({ ids: ['t1', 't2'] });
    expect(service.create({ title: 'a', repoId: '  r1  ' }).repoId).toBe('r1');
    expect(service.create({ title: 'b', repoId: '   ' }).repoId).toBeNull();
  });

  it('rejects an over-long repo id', () => {
    const { service } = makeService();
    expect(() =>
      service.create({
        title: 'ok',
        repoId: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('honours an explicit (backdated) date, priority, kind, notes and PR url', () => {
    const { service } = makeService({ ids: ['t1'] });
    const task = service.create({
      title: 'Review PR',
      notes: '  look at auth  ',
      priority: 'p0',
      kind: 'pr',
      prUrl: '  https://github.com/o/r/pull/7  ',
      date: '2025-01-15',
    });
    expect(task).toMatchObject({
      notes: 'look at auth',
      priority: 'p0',
      kind: 'pr',
      prUrl: 'https://github.com/o/r/pull/7',
      date: '2025-01-15',
    });
  });

  it('rejects an empty title', () => {
    const { service } = makeService();
    expect(() => service.create({ title: '   ' })).toThrow(ValidationError);
  });

  it('rejects an over-long title', () => {
    const { service } = makeService();
    expect(() =>
      service.create({ title: 'x'.repeat(plannerDefaults.maxTitleLength + 1) }),
    ).toThrow(ValidationError);
  });

  it('rejects over-long notes', () => {
    const { service } = makeService();
    expect(() =>
      service.create({
        title: 'ok',
        notes: 'x'.repeat(plannerDefaults.maxNotesLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long PR url', () => {
    const { service } = makeService();
    expect(() =>
      service.create({
        title: 'ok',
        prUrl: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an invalid date format', () => {
    const { service } = makeService();
    expect(() => service.create({ title: 'ok', date: '02/10/2026' })).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown priority', () => {
    const { service } = makeService();
    expect(() =>
      service.create({ title: 'ok', priority: 'p9' as never }),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown kind', () => {
    const { service } = makeService();
    expect(() =>
      service.create({ title: 'ok', kind: 'epic' as never }),
    ).toThrow(ValidationError);
  });
});

describe('planner service list', () => {
  it('returns tasks newest date first', () => {
    const { service } = makeService({
      ids: ['a', 'b'],
      times: ['2026-02-10T08:00:00.000Z', '2026-02-10T09:00:00.000Z'],
    });
    service.create({ title: 'old', date: '2025-01-01' });
    service.create({ title: 'new', date: '2026-05-05' });
    expect(service.list().map((t) => t.title)).toEqual(['new', 'old']);
  });
});

describe('planner service update', () => {
  let service: PlannerService;
  let id: string;
  beforeEach(() => {
    const made = makeService({
      ids: ['t1'],
      times: ['2026-02-10T08:00:00.000Z', '2026-02-11T08:00:00.000Z'],
    });
    service = made.service;
    id = service.create({ title: 'original' }).id;
  });

  it('applies a full patch and bumps updatedAt', () => {
    const updated = service.update(id, {
      title: ' new title ',
      notes: ' notes ',
      priority: 'p1',
      kind: 'pr',
      prUrl: ' https://x/pull/1 ',
      date: '2024-12-31',
      status: 'done',
    });
    expect(updated).toMatchObject({
      title: 'new title',
      notes: 'notes',
      priority: 'p1',
      kind: 'pr',
      prUrl: 'https://x/pull/1',
      date: '2024-12-31',
      status: 'done',
    });
    expect(updated.updatedAt).toBe('2026-02-11T08:00:00.000Z');
    expect(updated.createdAt).toBe('2026-02-10T08:00:00.000Z');
  });

  it('leaves unspecified fields unchanged', () => {
    const updated = service.update(id, { status: 'done' });
    expect(updated.title).toBe('original');
    expect(updated.status).toBe('done');
  });

  it('rejects an invalid title in a patch', () => {
    expect(() => service.update(id, { title: '  ' })).toThrow(ValidationError);
  });

  it('rejects over-long notes in a patch', () => {
    expect(() =>
      service.update(id, { notes: 'x'.repeat(plannerDefaults.maxNotesLength + 1) }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long PR url in a patch', () => {
    expect(() =>
      service.update(id, { prUrl: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1) }),
    ).toThrow(ValidationError);
  });

  it('rejects an invalid date in a patch', () => {
    expect(() => service.update(id, { date: 'nope' })).toThrow(ValidationError);
  });

  it('rejects an unknown priority in a patch', () => {
    expect(() => service.update(id, { priority: 'z' as never })).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown kind in a patch', () => {
    expect(() => service.update(id, { kind: 'x' as never })).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown status in a patch', () => {
    expect(() => service.update(id, { status: 'archived' as never })).toThrow(
      ValidationError,
    );
  });

  it('throws when updating an unknown task', () => {
    expect(() => service.update('missing', { status: 'done' })).toThrow(
      NotFoundError,
    );
  });

  it('records a launch link and trims its references', () => {
    const updated = service.update(id, {
      repoId: '  r1  ',
      launchKind: 'session',
      featureId: ' f1 ',
      sessionId: ' s1 ',
      launchLabel: '  Fix the login bug  ',
    });
    expect(updated).toMatchObject({
      repoId: 'r1',
      launchKind: 'session',
      featureId: 'f1',
      sessionId: 's1',
      launchLabel: 'Fix the login bug',
    });
  });

  it('clears a launch link when passed nulls and blanks', () => {
    service.update(id, {
      launchKind: 'agent',
      featureId: 'f1',
      launchLabel: 'x',
    });
    const cleared = service.update(id, {
      launchKind: null,
      featureId: '   ',
      sessionId: null,
      launchLabel: null,
      repoId: null,
    });
    expect(cleared).toMatchObject({
      launchKind: null,
      featureId: null,
      sessionId: null,
      launchLabel: null,
      repoId: null,
    });
  });

  it('rejects an unknown launch kind in a patch', () => {
    expect(() =>
      service.update(id, { launchKind: 'deploy' as never }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long feature id in a patch', () => {
    expect(() =>
      service.update(id, {
        featureId: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long session id in a patch', () => {
    expect(() =>
      service.update(id, {
        sessionId: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long repo id in a patch', () => {
    expect(() =>
      service.update(id, {
        repoId: 'x'.repeat(plannerDefaults.maxPrUrlLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long launch label in a patch', () => {
    expect(() =>
      service.update(id, {
        launchLabel: 'x'.repeat(plannerDefaults.maxTitleLength + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('defers a task to the backlog and restores it', () => {
    const deferred = service.update(id, { backloggedAt: '2026-02-10' });
    expect(deferred.backloggedAt).toBe('2026-02-10');
    const restored = service.update(id, { backloggedAt: null });
    expect(restored.backloggedAt).toBeNull();
  });

  it('rejects a malformed backlog date in a patch', () => {
    expect(() =>
      service.update(id, { backloggedAt: '10-02-2026' }),
    ).toThrow(ValidationError);
  });
});

describe('planner service remove', () => {
  it('deletes an existing task', () => {
    const { service, repo } = makeService({ ids: ['t1'] });
    const id = service.create({ title: 'x' }).id;
    service.remove(id);
    expect(repo.get(id)).toBeNull();
  });

  it('throws when removing an unknown task', () => {
    const { service } = makeService();
    expect(() => service.remove('missing')).toThrow(NotFoundError);
  });
});
