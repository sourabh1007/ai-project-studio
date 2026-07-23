import { describe, it, expect } from 'vitest';
import { createSessionSummaryRoutes } from './session-summary-controller.js';
import type {
  SessionSummarizer,
  SessionSummary,
  SummarizeSessionRequest,
} from '../session-summary/session-summary-contract.js';
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

const summary: SessionSummary = {
  sessionId: 's1',
  content: 'A generated summary',
  createdAt: '2025-01-01T00:00:00.000Z',
};

function harness(existing: SessionSummary | null = null) {
  const calls: SummarizeSessionRequest[] = [];
  const summarizer: SessionSummarizer = {
    summarize: async (request) => {
      calls.push(request);
      return summary;
    },
    get: (sessionId) => (existing && existing.sessionId === sessionId ? existing : null),
  };
  return { routes: createSessionSummaryRoutes({ sessionSummaries: summarizer }), calls };
}

const POST = 'post';
const GET = 'get';
const PATH = '/features/:featureId/sessions/:sessionId/summary';

describe('session-summary-controller', () => {
  it('generates a summary on POST for the requested session', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, POST, PATH)(
      req({ params: { featureId: 'f1', sessionId: 's1' } }),
    );
    expect(result).toEqual({ status: 200, body: summary });
    expect(calls).toEqual([{ sessionId: 's1' }]);
  });

  it('returns a stored summary on GET', async () => {
    const { routes } = harness(summary);
    const result = await pick(routes, GET, PATH)(
      req({ params: { featureId: 'f1', sessionId: 's1' } }),
    );
    expect(result).toEqual({ status: 200, body: summary });
  });

  it('returns 404 on GET when no summary exists', async () => {
    const { routes } = harness(null);
    const result = await pick(routes, GET, PATH)(
      req({ params: { featureId: 'f1', sessionId: 's1' } }),
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: { kind: 'not_found', message: 'No summary yet' },
    });
  });
});
