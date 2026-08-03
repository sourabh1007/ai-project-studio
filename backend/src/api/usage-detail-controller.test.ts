import { describe, it, expect } from 'vitest';
import { createUsageDetailRoutes } from './usage-detail-controller.js';
import type { UsageDetailService } from '../usage-detail/usage-detail-service.js';
import type { StoredUsage } from '../usage/usage-repo-port.js';
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

function usage(sessionId: string): StoredUsage {
  return {
    sessionId,
    featureId: 'f1',
    turnIndex: 0,
    kind: 'dev',
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: 'gpt',
    operation: 'chat',
    inputTokens: 1,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 0.1,
    credits: 0.1,
    nanoAiu: 100,
    serviceRequestId: null,
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:00:01.000Z',
  };
}

function harness() {
  const calls: Record<string, string> = {};
  const usageDetail: UsageDetailService = {
    forSession: (id) => {
      calls.session = id;
      return [usage('s1')];
    },
    forFeature: (id) => {
      calls.feature = id;
      return [usage('s2')];
    },
    forRepo: (id) => {
      calls.repo = id;
      return [usage('s3')];
    },
  };
  return { routes: createUsageDetailRoutes({ usageDetail }), calls };
}

describe('usage-detail-controller', () => {
  it('returns a session breakdown', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'get', '/sessions/:sessionId/usage')(
      req({ params: { sessionId: 's1' } }),
    );
    expect(result).toEqual({ status: 200, body: [usage('s1')] });
    expect(calls.session).toBe('s1');
  });

  it('returns a feature breakdown', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'get', '/features/:featureId/usage/events')(
      req({ params: { featureId: 'f9' } }),
    );
    expect(result).toEqual({ status: 200, body: [usage('s2')] });
    expect(calls.feature).toBe('f9');
  });

  it('returns a repo breakdown', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'get', '/repos/:repoId/usage/events')(
      req({ params: { repoId: 'r9' } }),
    );
    expect(result).toEqual({ status: 200, body: [usage('s3')] });
    expect(calls.repo).toBe('r9');
  });
});
