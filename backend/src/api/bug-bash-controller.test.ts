import { describe, it, expect } from 'vitest';
import { createBugBashRoutes } from './bug-bash-controller.js';
import type { HttpResult, Route } from './http-contract.js';
import type {
  BugBashRun,
  BugBashService,
} from '../bug-bash/bug-bash-contract.js';

function run(overrides: Partial<BugBashRun> = {}): BugBashRun {
  return {
    id: 'a1',
    featureId: 'f1',
    featureInfo: 'a feature',
    setupInfo: '',
    otherInfo: '',
    prerequisites: [],
    scenarios: [],
    report: null,
    status: 'draft',
    error: null,
    agents: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function service(overrides: Partial<BugBashService> = {}): BugBashService {
  return {
    get: () => run(),
    saveInputs: () => run(),
    generatePrerequisites: async () => run(),
    savePrerequisiteAnswers: () => run(),
    generate: async () => run({ status: 'generated' }),
    run: async () => undefined,
    reset: () => run(),
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

describe('bug-bash-controller', () => {
  it('returns the current run (or null) for an attachment', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(routes, 'get', '/features/:featureId/bug-bash/:attachmentId');
    const result = await call(route, {
      params: { featureId: 'f1', attachmentId: 'a1' },
    });
    expect(result).toEqual({ status: 200, body: { run: run() } });
  });

  it('saves valid inputs', async () => {
    let saved: unknown;
    const routes = createBugBashRoutes({
      bugBash: service({
        saveInputs: (id, featureId, inputs) => {
          saved = { id, featureId, inputs };
          return run();
        },
      }),
    });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/inputs',
    );
    const result = await call(route, {
      params: { featureId: 'f1', attachmentId: 'a1' },
      body: { featureInfo: 'a feature', setupInfo: 'docs', otherInfo: 'extra' },
    });
    expect(result.status).toBe(200);
    expect(saved).toEqual({
      id: 'a1',
      featureId: 'f1',
      inputs: { featureInfo: 'a feature', setupInfo: 'docs', otherInfo: 'extra' },
    });
  });

  it('defaults a missing setupInfo and otherInfo to empty', async () => {
    let seen: unknown;
    const routes = createBugBashRoutes({
      bugBash: service({
        saveInputs: (_id, _featureId, inputs) => {
          seen = inputs;
          return run();
        },
      }),
    });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/inputs',
    );
    await call(route, {
      params: { attachmentId: 'a1' },
      body: { featureInfo: 'x' },
    });
    expect(seen).toEqual({ featureInfo: 'x', setupInfo: '', otherInfo: '' });
  });

  it('rejects a missing featureInfo', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/inputs',
    );
    await expect(call(route, { body: { featureInfo: '  ' } })).rejects.toThrow(
      'non-empty "featureInfo"',
    );
  });

  it('rejects a non-string setupInfo', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/inputs',
    );
    await expect(
      call(route, { body: { featureInfo: 'x', setupInfo: 5 } }),
    ).rejects.toThrow('"setupInfo" must be a string');
  });

  it('rejects a non-string otherInfo', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/inputs',
    );
    await expect(
      call(route, { body: { featureInfo: 'x', otherInfo: 5 } }),
    ).rejects.toThrow('"otherInfo" must be a string');
  });

  it('generates prerequisite questions for an attachment', async () => {
    let seen: string | undefined;
    const routes = createBugBashRoutes({
      bugBash: service({
        generatePrerequisites: async (id) => {
          seen = id;
          return run({ prerequisites: [{ id: 'prereq-1', question: 'Q', detail: '', answer: '' }] });
        },
      }),
    });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/prerequisites',
    );
    const result = await call(route, { params: { attachmentId: 'a1' } });
    expect(seen).toBe('a1');
    expect(result.status).toBe(200);
    expect((result.body as BugBashRun).prerequisites).toHaveLength(1);
  });

  it('saves prerequisite answers', async () => {
    let seen: unknown;
    const routes = createBugBashRoutes({
      bugBash: service({
        savePrerequisiteAnswers: (_id, answers) => {
          seen = answers;
          return run();
        },
      }),
    });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/prerequisites/answers',
    );
    const result = await call(route, {
      params: { attachmentId: 'a1' },
      body: { answers: [{ id: 'prereq-1', answer: 'yes' }, { id: 'prereq-2' }] },
    });
    expect(result.status).toBe(200);
    expect(seen).toEqual([
      { id: 'prereq-1', answer: 'yes' },
      { id: 'prereq-2', answer: '' },
    ]);
  });

  it('rejects prerequisite answers that are not an array', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/prerequisites/answers',
    );
    await expect(call(route, { body: {} })).rejects.toThrow(
      'An "answers" array is required.',
    );
  });

  it('rejects a prerequisite answer with no id', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/prerequisites/answers',
    );
    await expect(
      call(route, { body: { answers: [{ answer: 'x' }] } }),
    ).rejects.toThrow('non-empty "id"');
  });

  it('rejects a prerequisite answer with a non-string answer', async () => {
    const routes = createBugBashRoutes({ bugBash: service() });
    const route = find(
      routes,
      'post',
      '/features/:featureId/bug-bash/:attachmentId/prerequisites/answers',
    );
    await expect(
      call(route, { body: { answers: [{ id: 'p1', answer: 5 }] } }),
    ).rejects.toThrow('"answer" must be a string');
  });
});
