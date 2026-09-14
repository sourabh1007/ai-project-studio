import { describe, expect, it } from 'vitest';
import { createUsageRollupRoutes } from './usage-rollup-controller.js';
import type { UsageRollupService } from '../usage-rollup/usage-rollup-service.js';
import type { UsageGranularity, UsageRollup } from '../usage-rollup/usage-rollup-contract.js';
import type { PersistedMetaUsage } from '../meta/meta-usage-contract.js';
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

function rollup(scope: UsageRollup['scope'], granularity: UsageGranularity): UsageRollup {
  return {
    scope,
    granularity,
    totals: {
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      cost: 0,
      credits: 0,
      nanoAiu: 0,
    },
    periods: [],
    byModel: [],
    byProvider: [],
  };
}

function makeDeps() {
  const calls: string[] = [];
  const rollups = {
    workspace: (g: UsageGranularity) => {
      calls.push(`workspace:${g}`);
      return rollup('workspace', g);
    },
    ide: (g: UsageGranularity) => {
      calls.push(`ide:${g}`);
      return rollup('ide', g);
    },
    feature: (id: string, g: UsageGranularity) => {
      calls.push(`feature:${id}:${g}`);
      return rollup('feature', g);
    },
  } as unknown as UsageRollupService;
  const record: PersistedMetaUsage = {
    sessionId: 'w1',
    featureId: 'f1',
    providerId: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt-5.4',
    transport: 'warm-acp',
    providerSessionId: null,
    purpose: 'review',
    label: null,
    inputTokens: 1,
    outputTokens: 1,
    nanoAiu: 5,
    credits: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const metaUsage = { listRecent: (limit: number) => { calls.push(`recent:${limit}`); return [record]; } };
  const routes = createUsageRollupRoutes({ rollups, metaUsage, activityLimit: 25 });
  return { routes, calls, record };
}

describe('usage-rollup-controller', () => {
  it('serves the workspace rollup with the requested granularity', () => {
    const { routes, calls } = makeDeps();
    const res = pick(routes, 'get', '/usage/rollup')(req({ query: { granularity: 'week' } }));
    expect(res.status).toBe(200);
    expect((res.body as UsageRollup).scope).toBe('workspace');
    expect(calls).toContain('workspace:week');
  });

  it('defaults an unknown granularity to month for the IDE rollup', () => {
    const { routes, calls } = makeDeps();
    pick(routes, 'get', '/usage/ide/rollup')(req({ query: { granularity: 'nope' } }));
    expect(calls).toContain('ide:month');
  });

  it('serves the IDE activity feed bounded by the configured limit', () => {
    const { routes, calls, record } = makeDeps();
    const res = pick(routes, 'get', '/usage/ide/activity')(req());
    expect(res.body).toEqual({ records: [record] });
    expect(calls).toContain('recent:25');
  });

  it('serves a feature rollup keyed by the path param', () => {
    const { routes, calls } = makeDeps();
    const res = pick(routes, 'get', '/features/:featureId/usage/rollup')(
      req({ params: { featureId: 'fX' }, query: { granularity: 'year' } }),
    );
    expect((res.body as UsageRollup).scope).toBe('feature');
    expect(calls).toContain('feature:fX:year');
  });
});
