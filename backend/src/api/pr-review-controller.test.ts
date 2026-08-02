import { describe, expect, it } from 'vitest';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { PrReviewService } from '../pr-review/pr-review-service.js';
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

const review: PrReview = {
  featureId: 'f1',
  repoId: 'r1',
  pull: { number: 7, title: 'Add retry', url: 'https://example.com/pr/7' },
  worktreePath: 'C:\\work\\pr-7',
  baseBranch: 'main',
  status: 'ready',
  summary: 'Adds retry.',
  coreAnalysis: '- wraps client',
  changedFiles: 3,
  timestamps: {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    generatedAt: '2026-01-01T00:01:00.000Z',
  },
  failure: null,
};

function harness() {
  const calls: Record<string, unknown[]> = {};
  const prReviews = {
    get: (id: string) => (calls.get = [id], review),
    refresh: (id: string) => (calls.refresh = [id], review),
  } as unknown as PrReviewService;
  return { routes: createPrReviewRoutes({ prReviews }), calls };
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
});
