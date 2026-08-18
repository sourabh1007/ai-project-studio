import { describe, expect, it } from 'vitest';
import { createReviewBoardRoutes } from './review-board-controller.js';
import type { HttpRequest, Route } from './http-contract.js';
import type { ReviewBoard } from '../review-board/review-board-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

const board = { featureId: 'f1' } as ReviewBoard;

describe('createReviewBoardRoutes', () => {
  it('returns the derived board for a feature', () => {
    const routes = createReviewBoardRoutes({
      reviewBoard: { get: (id) => ({ ...board, featureId: id }) },
    });
    const handler = pick(routes, 'get', '/features/:featureId/review-board');
    const res = handler(req({ params: { featureId: 'abc' } }));
    expect(res.status).toBe(200);
    expect((res.body as ReviewBoard).featureId).toBe('abc');
  });
});
