import { describe, it, expect } from 'vitest';
import { createSummaryRoutes } from './summary-controller.js';
import type {
  FeatureSummarizer,
  FeatureSummary,
  SummarizeRequest,
} from '../summarizer/summarizer-contract.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
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

const summary: FeatureSummary = {
  featureId: 'f1',
  content: 'done',
  createdAt: '2025-01-01T00:00:00.000Z',
};

function harness(stored: FeatureSummary | null) {
  const requests: SummarizeRequest[] = [];
  const summarizer: FeatureSummarizer = {
    summarize: async (request) => {
      requests.push(request);
      return summary;
    },
  };
  const summaries: SummaryStore = {
    save: () => undefined,
    load: () => stored,
    delete: () => undefined,
  };
  return { routes: createSummaryRoutes({ summarizer, summaries }), requests };
}

describe('summary-controller', () => {
  it('generates a summary', async () => {
    const h = harness(null);
    const result = await pick(h.routes, 'post', '/features/:featureId/summary')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(result).toEqual({ status: 200, body: summary });
    expect(h.requests).toEqual([{ featureId: 'f1' }]);
  });

  it('reads an existing summary', async () => {
    const h = harness(summary);
    const result = await pick(h.routes, 'get', '/features/:featureId/summary')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(result).toEqual({ status: 200, body: summary });
  });

  it('returns 404 when no summary exists', async () => {
    const h = harness(null);
    const result = await pick(h.routes, 'get', '/features/:featureId/summary')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(result.status).toBe(404);
  });
});
