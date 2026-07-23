import { describe, it, expect } from 'vitest';
import { createWorkSummaryRoutes } from './work-summary-controller.js';
import type {
  FeatureWorkSummary,
  FeatureWorkSummaryService,
} from '../feature/feature-work-summary-contract.js';
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

describe('work-summary-controller', () => {
  it('returns the feature work summary from the service', async () => {
    const summary: FeatureWorkSummary = {
      featureId: 'f1',
      sessions: [
        {
          sessionId: 's1',
          prompt: 'p',
          status: 'completed',
          createdAt: '2024-01-01T00:00:00Z',
          summary: 'did stuff',
          checkpoints: [],
        },
      ],
    };
    const service: FeatureWorkSummaryService = {
      getByFeature: (id) => {
        expect(id).toBe('f1');
        return summary;
      },
    };

    const result = await pick(
      createWorkSummaryRoutes({ workSummaries: service }),
      'get',
      '/features/:featureId/work-summary',
    )(req({ params: { featureId: 'f1' } }));

    expect(result).toEqual({ status: 200, body: summary });
  });
});
