import { describe, it, expect, vi } from 'vitest';
import { createAggregateRoutes, type AggregateControllerDeps } from './aggregate-controller.js';
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
  byMcpServer: [],
  bySession: [
    {
      sessionId: 's1',
      provider: 'copilot',
      kind: 'dev',
      status: 'running',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: null,
      activeMs: 1000,
      groupId: null,
      origin: 'user',
      ...totals,
    },
  ],
  timing: { totalActiveMs: 1000 },
  groups: [],
};

function harness(summary?: AggregateControllerDeps['summary']) {
  const analytics: FeatureAnalyticsService = {
    forFeature: () => analyticsResult,
    workspaceTotals: () => totals,
    workspaceStats: () => ({ totals, activeSessions: 3, totalSessions: 5 }),
  };
  return createAggregateRoutes({ analytics, summary });
}

describe('aggregate-controller', () => {
  it('awaits the hierarchy snapshot and forwards request cancellation', async () => {
    const snapshot = { features: {}, unattributed: null };
    const summary = vi.fn().mockResolvedValue(snapshot);
    const controller = new AbortController();
    const response = await pick(harness(summary), 'get', '/usage/summary')(
      req({ signal: controller.signal }),
    );
    expect(summary).toHaveBeenCalledWith(controller.signal);
    expect(response).toEqual({ status: 200, body: snapshot });
  });

  it('does not block unrelated routes while the snapshot worker is running', async () => {
    let finish!: (value: { features: {}; unattributed: null }) => void;
    const pending = new Promise<{ features: {}; unattributed: null }>((resolve) => { finish = resolve; });
    const routes = harness(() => pending);
    const snapshot = pick(routes, 'get', '/usage/summary')(req());
    expect(await pick(routes, 'get', '/usage/totals')(req())).toEqual({ status: 200, body: totals });
    finish({ features: {}, unattributed: null });
    await snapshot;
  });

  it('propagates worker failures rather than returning an empty snapshot', async () => {
    const failure = new Error('Summary worker could not read the database');
    await expect(pick(harness(() => Promise.reject(failure)), 'get', '/usage/summary')(req()))
      .rejects.toBe(failure);
  });

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
