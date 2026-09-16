import { describe, it, expect } from 'vitest';
import { createNewTaskRoutes } from './new-task-controller.js';
import type { HttpResult, Route } from './http-contract.js';
import type {
  NewTaskRun,
  NewTaskService,
} from '../new-task/new-task-contract.js';

function run(overrides: Partial<NewTaskRun> = {}): NewTaskRun {
  return {
    id: 'a1',
    featureId: 'f1',
    problem: 'p',
    context: '',
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

function service(overrides: Partial<NewTaskService> = {}): NewTaskService {
  return {
    get: () => run(),
    saveInputs: () => run(),
    plan: async () => run({ status: 'planned', plan: 'the plan' }),
    implement: async () => undefined,
    fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
    ...overrides,
  };
}

function find(routes: Route[], method: string, path: string): Route {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function call(
  route: Route,
  req: Partial<Parameters<Route['handler']>[0]>,
): Promise<HttpResult> {
  return route.handler({ params: {}, query: {}, body: {}, ...req });
}

describe('new-task-controller', () => {
  it('returns the current run (or null) for an attachment', async () => {
    const routes = createNewTaskRoutes({ newTask: service() });
    const route = find(routes, 'get', '/features/:featureId/new-task/:attachmentId');
    const result = await call(route, { params: { featureId: 'f1', attachmentId: 'a1' } });
    expect(result).toEqual({ status: 200, body: { run: run() } });
  });

  it('saves valid inputs', async () => {
    let saved: unknown;
    const routes = createNewTaskRoutes({
      newTask: service({
        saveInputs: (id, featureId, inputs) => {
          saved = { id, featureId, inputs };
          return run();
        },
      }),
    });
    const route = find(routes, 'post', '/features/:featureId/new-task/:attachmentId/inputs');
    const result = await call(route, {
      params: { featureId: 'f1', attachmentId: 'a1' },
      body: { problem: 'do it', context: 'ctx' },
    });
    expect(result.status).toBe(200);
    expect(saved).toEqual({
      id: 'a1',
      featureId: 'f1',
      inputs: { problem: 'do it', context: 'ctx' },
    });
  });

  it('defaults a missing context to empty', async () => {
    let seen: unknown;
    const routes = createNewTaskRoutes({
      newTask: service({
        saveInputs: (_id, _featureId, inputs) => {
          seen = inputs;
          return run();
        },
      }),
    });
    const route = find(routes, 'post', '/features/:featureId/new-task/:attachmentId/inputs');
    await call(route, { params: { attachmentId: 'a1' }, body: { problem: 'x' } });
    expect(seen).toEqual({ problem: 'x', context: '' });
  });

  it('rejects a missing problem', async () => {
    const routes = createNewTaskRoutes({ newTask: service() });
    const route = find(routes, 'post', '/features/:featureId/new-task/:attachmentId/inputs');
    await expect(call(route, { body: { problem: '  ' } })).rejects.toThrow(
      'non-empty "problem"',
    );
  });

  it('rejects a non-string context', async () => {
    const routes = createNewTaskRoutes({ newTask: service() });
    const route = find(routes, 'post', '/features/:featureId/new-task/:attachmentId/inputs');
    await expect(
      call(route, { body: { problem: 'x', context: 5 } }),
    ).rejects.toThrow('"context" must be a string');
  });

  it('returns a file diff for a valid path query', async () => {
    let seen: unknown;
    const routes = createNewTaskRoutes({
      newTask: service({
        fileDiff: async (attachmentId, path) => {
          seen = { attachmentId, path };
          return { path, diff: 'DIFF', content: 'BODY' };
        },
      }),
    });
    const route = find(
      routes,
      'get',
      '/features/:featureId/new-task/:attachmentId/file-diff',
    );
    const result = await call(route, {
      params: { featureId: 'f1', attachmentId: 'a1' },
      query: { path: 'src/a.ts' },
    });
    expect(seen).toEqual({ attachmentId: 'a1', path: 'src/a.ts' });
    expect(result).toEqual({
      status: 200,
      body: { path: 'src/a.ts', diff: 'DIFF', content: 'BODY' },
    });
  });

  it('rejects a file-diff request with a missing path', async () => {
    const routes = createNewTaskRoutes({ newTask: service() });
    const route = find(
      routes,
      'get',
      '/features/:featureId/new-task/:attachmentId/file-diff',
    );
    await expect(
      call(route, { params: { attachmentId: 'a1' }, query: {} }),
    ).rejects.toThrow('non-empty "path"');
  });

  it('rejects a file-diff request with a blank path', async () => {
    const routes = createNewTaskRoutes({ newTask: service() });
    const route = find(
      routes,
      'get',
      '/features/:featureId/new-task/:attachmentId/file-diff',
    );
    await expect(
      call(route, { params: { attachmentId: 'a1' }, query: { path: '  ' } }),
    ).rejects.toThrow('non-empty "path"');
  });
});
