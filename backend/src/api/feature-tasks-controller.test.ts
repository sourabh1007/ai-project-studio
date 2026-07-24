import { describe, it, expect } from 'vitest';
import { createFeatureTasksRoutes } from './feature-tasks-controller.js';
import type { FeatureTasksService } from '../feature-tasks/feature-tasks-service.js';
import type { FeatureTask } from '../feature-tasks/feature-tasks-contract.js';
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

const task: FeatureTask = {
  id: 't1',
  featureId: 'f1',
  title: 'A task',
  detail: '',
  status: 'pending',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function harness() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const tasks = {
    listForFeature: (id: string) => (record('listForFeature', id), [task]),
    generate: async (id: string) => (record('generate', id), [task]),
    addTask: (input: unknown) => (record('addTask', input), task),
    toggle: (id: string) => (record('toggle', id), task),
    removeTask: (id: string) => record('removeTask', id),
  } as unknown as FeatureTasksService;
  return { routes: createFeatureTasksRoutes({ tasks }), calls };
}

describe('feature-tasks-controller', () => {
  it('lists tasks for a feature', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'get', '/features/:featureId/tasks')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(res).toEqual({ status: 200, body: [task] });
    expect(calls.listForFeature).toEqual(['f1']);
  });

  it('generates a plan for a feature', async () => {
    const { routes, calls } = harness();
    const res = await pick(routes, 'post', '/features/:featureId/tasks/generate')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(res).toEqual({ status: 201, body: [task] });
    expect(calls.generate).toEqual(['f1']);
  });

  it('adds a manual task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'post', '/features/:featureId/tasks')(
      req({ params: { featureId: 'f1' }, body: { title: 'New', detail: 'd' } }),
    );
    expect(res).toEqual({ status: 201, body: task });
    expect(calls.addTask).toEqual([{ featureId: 'f1', title: 'New', detail: 'd' }]);
  });

  it('rejects an invalid add-task body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'post', '/features/:featureId/tasks');
    expect(() => handler(req({ params: { featureId: 'f1' }, body: { title: '' } }))).toThrow();
  });

  it('toggles a task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'put', '/tasks/:taskId')(
      req({ params: { taskId: 't1' } }),
    );
    expect(res).toEqual({ status: 200, body: task });
    expect(calls.toggle).toEqual(['t1']);
  });

  it('removes a task', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'delete', '/tasks/:taskId')(
      req({ params: { taskId: 't1' } }),
    );
    expect(res).toEqual({ status: 200, body: { id: 't1' } });
    expect(calls.removeTask).toEqual(['t1']);
  });
});
