import { describe, it, expect } from 'vitest';
import { createAggregateRoutes } from './aggregate-controller.js';
import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type {
  FeatureAnalytics,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';
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

const totals: UsageTotals = {
  sessions: 2,
  inputTokens: 100,
  outputTokens: 20,
  reasoningOutputTokens: 5,
  cost: 0.66,
  credits: 0.66,
  nanoAiu: 1000,
};

const analyticsResult: FeatureAnalytics = {
  totals,
  byModel: [{ model: 'm', ...totals }],
  byProvider: [{ provider: 'p', ...totals }],
  byDay: [{ day: '2025-01-01', ...totals }],
  bySession: [
    {
      sessionId: 's1',
      provider: 'copilot',
      kind: 'dev',
      status: 'running',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: null,
      activeMs: 1000,
      ...totals,
    },
  ],
  timing: { totalActiveMs: 1000 },
};

function harness() {
  const analytics: FeatureAnalyticsService = {
    forFeature: () => analyticsResult,
    workspaceTotals: () => totals,
    workspaceStats: () => ({ totals, activeSessions: 3, totalSessions: 5 }),
  };
  return createAggregateRoutes({ analytics });
}

describe('aggregate-controller', () => {
  it('returns composed feature analytics', async () => {
    const result = await pick(harness(), 'get', '/features/:featureId/usage')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual(analyticsResult);
  });

  it('returns workspace totals', async () => {
    const result = await pick(harness(), 'get', '/usage/totals')(req());
    expect(result).toEqual({ status: 200, body: totals });
  });

  it('returns workspace stats', async () => {
    const result = await pick(harness(), 'get', '/usage/workspace')(req());
    expect(result).toEqual({
      status: 200,
      body: { totals, activeSessions: 3, totalSessions: 5 },
    });
  });
});
