import { describe, expect, it } from 'vitest';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { PrReviewService } from '../pr-review/pr-review-service.js';
import type {
  PrCommentThread,
  PrCommentsService,
} from '../pr-review/pr-comments-contract.js';
import { createPrReviewRoutes } from './pr-review-controller.js';
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

function step(status: PrReview['problemStatement']['status']) {
  return {
    status,
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
  };
}

const review: PrReview = {
  featureId: 'f1',
  repoId: 'r1',
  pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
  worktreePath: 'C:\\work\\pr-7',
  baseBranch: 'main',
  description: 'desc',
  problemStatement: { ...step('ready'), content: 'p', sufficient: true },
  changeGraph: {
    ...step('ready'),
    projects: [{ id: 'src/App.csproj', name: 'App', path: 'src/App.csproj' }],
    nodes: [
      {
        path: 'src/A.cs',
        projectId: 'src/App.csproj',
        module: 'App',
        category: 'code',
        changeKind: 'modified',
        diff: '@@',
        whatItDoes: 'does',
        whatChanged: 'changed',
      },
    ],
    edges: [],
  },
  changedFiles: 3,
  timestamps: {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  },
};

function harness() {
  const calls: Record<string, unknown[]> = {};
  const prReviews = {
    get: (id: string) => ((calls.get = [id]), review),
    refresh: (id: string) => ((calls.refresh = [id]), review),
    retryStep: (id: string, s: string) => ((calls.retryStep = [id, s]), review),
    explainFile: (id: string, path: string) => (
      (calls.explainFile = [id, path]), Promise.resolve(review)
    ),
  } as unknown as PrReviewService;
  const thread: PrCommentThread = {
    id: 't1',
    path: 'a.ts',
    line: 3,
    status: 'active',
    comments: [],
  };
  const prComments = {
    list: (id: string) => ((calls.list = [id]), Promise.resolve([thread])),
    add: (id: string, input: unknown) => (
      (calls.add = [id, input]), Promise.resolve(thread)
    ),
    setStatus: (id: string, threadId: string, status: string) => (
      (calls.setStatus = [id, threadId, status]), Promise.resolve(thread)
    ),
  } as unknown as PrCommentsService;
  return {
    routes: createPrReviewRoutes({ prReviews, prComments }),
    calls,
    thread,
  };
}

describe('pr-review-controller', () => {
  it('reads the review for a feature', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'get', '/features/:featureId/pr-review')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(res).toEqual({ status: 200, body: review });
    expect(calls.get).toEqual(['f1']);
  });

  it('refreshes the review for a feature', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'post', '/features/:featureId/pr-review/refresh')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(res).toEqual({ status: 200, body: review });
    expect(calls.refresh).toEqual(['f1']);
  });

  it('retries a single valid step', () => {
    const { routes, calls } = harness();
    const res = pick(
      routes,
      'post',
      '/features/:featureId/pr-review/steps/:step/retry',
    )(req({ params: { featureId: 'f1', step: 'changeGraph' } }));
    expect(res).toEqual({ status: 200, body: review });
    expect(calls.retryStep).toEqual(['f1', 'changeGraph']);
  });

  it('rejects an unknown step', () => {
    const { routes } = harness();
    expect(() =>
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/steps/:step/retry',
      )(req({ params: { featureId: 'f1', step: 'bogus' } })),
    ).toThrow(/Unknown PR review step/);
  });

  it('explains a file from the request body', async () => {
    const { routes, calls } = harness();
    const res = await pick(
      routes,
      'post',
      '/features/:featureId/pr-review/files/explain',
    )(req({ params: { featureId: 'f1' }, body: { path: 'a.ts' } }));
    expect(res).toEqual({ status: 200, body: review });
    expect(calls.explainFile).toEqual(['f1', 'a.ts']);
  });

  it('rejects an explain request with no path', async () => {
    const { routes } = harness();
    await expect(
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/files/explain',
      )(req({ params: { featureId: 'f1' }, body: { path: '  ' } })),
    ).rejects.toThrow(/file "path" is required/);
  });

  it('rejects an explain request with a non-string path', async () => {
    const { routes } = harness();
    await expect(
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/files/explain',
      )(req({ params: { featureId: 'f1' }, body: {} })),
    ).rejects.toThrow(/file "path" is required/);
  });

  it('lists comments for a feature', async () => {
    const { routes, calls, thread } = harness();
    const res = await pick(
      routes,
      'get',
      '/features/:featureId/pr-review/comments',
    )(req({ params: { featureId: 'f1' } }));
    expect(res).toEqual({ status: 200, body: [thread] });
    expect(calls.list).toEqual(['f1']);
  });

  it('adds a comment from the request body', async () => {
    const { routes, calls, thread } = harness();
    const res = await pick(
      routes,
      'post',
      '/features/:featureId/pr-review/comments',
    )(
      req({
        params: { featureId: 'f1' },
        body: { path: 'a.ts', line: 3, body: 'nit' },
      }),
    );
    expect(res).toEqual({ status: 200, body: thread });
    expect(calls.add).toEqual(['f1', { path: 'a.ts', line: 3, body: 'nit' }]);
  });

  it('rejects an add-comment request with an invalid payload', async () => {
    const { routes } = harness();
    await expect(
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/comments',
      )(req({ params: { featureId: 'f1' }, body: { path: 'a.ts' } })),
    ).rejects.toThrow(/"line"/);
  });

  it('sets a comment thread status from the request body', async () => {
    const { routes, calls, thread } = harness();
    const res = await pick(
      routes,
      'post',
      '/features/:featureId/pr-review/comments/:threadId/status',
    )(
      req({
        params: { featureId: 'f1', threadId: 't1' },
        body: { status: 'resolved' },
      }),
    );
    expect(res).toEqual({ status: 200, body: thread });
    expect(calls.setStatus).toEqual(['f1', 't1', 'resolved']);
  });

  it('rejects a set-status request with no status', async () => {
    const { routes } = harness();
    await expect(
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/comments/:threadId/status',
      )(req({ params: { featureId: 'f1', threadId: 't1' }, body: {} })),
    ).rejects.toThrow(/"status" is required/);
  });

  it('rejects a set-status request with an unknown status', async () => {
    const { routes } = harness();
    await expect(
      pick(
        routes,
        'post',
        '/features/:featureId/pr-review/comments/:threadId/status',
      )(
        req({
          params: { featureId: 'f1', threadId: 't1' },
          body: { status: 'closed' },
        }),
      ),
    ).rejects.toThrow(/Unknown thread status/);
  });
});
