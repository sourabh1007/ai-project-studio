import { describe, it, expect } from 'vitest';
import { createPlannerRoutes } from './planner-controller.js';
import type { PlannerService } from '../planner/planner-service.js';
import type { PlannerTask } from '../planner/planner-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

const task: PlannerTask = {
  id: 't1',
  title: 'A task',
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
  createdAt: '2026-02-10T08:00:00.000Z',
  updatedAt: '2026-02-10T08:00:00.000Z',
};

function harness() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const planner = {
    list: () => (record('list'), [task]),
    create: (input: unknown) => (record('create', input), task),
    update: (id: string, patch: unknown) => (record('update', id, patch), task),
    remove: (id: string) => record('remove', id),
  } as unknown as PlannerService;
  return { routes: createPlannerRoutes({ planner }), calls };
}

describe('planner-controller', () => {
  it('lists tasks', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'get', '/planner/tasks')(req());
    expect(res).toEqual({ status: 200, body: [task] });
    expect(calls.list).toEqual([]);
  });

  it('creates a task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'post', '/planner/tasks')(
      req({ body: { title: 'New', priority: 'p0', kind: 'pr', prUrl: 'u', date: '2025-01-01' } }),
    );
    expect(res).toEqual({ status: 201, body: task });
    expect(calls.create).toEqual([
      { title: 'New', priority: 'p0', kind: 'pr', prUrl: 'u', date: '2025-01-01' },
    ]);
  });

  it('rejects an invalid create body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'post', '/planner/tasks');
    expect(() => handler(req({ body: { title: '' } }))).toThrow();
  });

  it('rejects an unknown priority on create', () => {
    const { routes } = harness();
    const handler = pick(routes, 'post', '/planner/tasks');
    expect(() =>
      handler(req({ body: { title: 'ok', priority: 'p9' } })),
    ).toThrow();
  });

  it('updates a task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'put', '/planner/tasks/:taskId')(
      req({ params: { taskId: 't1' }, body: { status: 'done' } }),
    );
    expect(res).toEqual({ status: 200, body: task });
    expect(calls.update).toEqual(['t1', { status: 'done' }]);
  });

  it('accepts a launch link on update', () => {
    const { routes, calls } = harness();
    pick(routes, 'put', '/planner/tasks/:taskId')(
      req({
        params: { taskId: 't1' },
        body: {
          launchKind: 'review',
          featureId: 'f1',
          sessionId: null,
          launchLabel: 'Review PR #9',
          repoId: 'r1',
        },
      }),
    );
    expect(calls.update).toEqual([
      't1',
      {
        launchKind: 'review',
        featureId: 'f1',
        sessionId: null,
        launchLabel: 'Review PR #9',
        repoId: 'r1',
      },
    ]);
  });

  it('accepts a backlog deferral on update', () => {
    const { routes, calls } = harness();
    pick(routes, 'put', '/planner/tasks/:taskId')(
      req({
        params: { taskId: 't1' },
        body: { backloggedAt: '2026-02-10' },
      }),
    );
    expect(calls.update).toEqual(['t1', { backloggedAt: '2026-02-10' }]);
  });

  it('rejects an unknown launch kind on update', () => {
    const { routes } = harness();
    const handler = pick(routes, 'put', '/planner/tasks/:taskId');
    expect(() =>
      handler(req({ params: { taskId: 't1' }, body: { launchKind: 'deploy' } })),
    ).toThrow();
  });

  it('rejects an invalid update body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'put', '/planner/tasks/:taskId');
    expect(() =>
      handler(req({ params: { taskId: 't1' }, body: { status: 'archived' } })),
    ).toThrow();
  });

  it('removes a task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'delete', '/planner/tasks/:taskId')(
      req({ params: { taskId: 't1' } }),
    );
    expect(res).toEqual({ status: 200, body: { id: 't1' } });
    expect(calls.remove).toEqual(['t1']);
  });
});
