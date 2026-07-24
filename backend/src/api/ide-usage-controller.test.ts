import { describe, it, expect } from 'vitest';
import { createIdeUsageRoutes } from './ide-usage-controller.js';
import type { IdeUsageService } from '../ide-usage/ide-usage-service.js';
import type { IdeUsage } from '../ide-usage/ide-usage-contract.js';
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

const payload: IdeUsage = {
  totals: {
    sessions: 1,
    inputTokens: 10,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    cost: 1,
    credits: 1,
    nanoAiu: 100,
  },
  byModel: [],
  byDay: [],
};

describe('ide-usage-controller', () => {
  it('serves the IDE AI usage payload', () => {
    const calls: string[] = [];
    const ideUsage = {
      read: () => {
        calls.push('read');
        return payload;
      },
    } as unknown as IdeUsageService;
    const routes = createIdeUsageRoutes({ ideUsage });

    const res = pick(routes, 'get', '/usage/ide')(req());

    expect(res).toEqual({ status: 200, body: payload });
    expect(calls).toEqual(['read']);
  });
});
