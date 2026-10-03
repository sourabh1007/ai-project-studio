import { describe, it, expect } from 'vitest';
import { createSystemHealthRoutes } from './system-health-controller.js';
import type { HttpRequest, Route } from './http-contract.js';
import type { SystemHealthReport } from '../health/health-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

describe('system-health-controller', () => {
  it('returns the aggregated report from the service', async () => {
    const report: SystemHealthReport = {
      generatedAt: 123,
      overall: 'degraded',
      checks: [
        { id: 'api', title: 'Backend API', state: 'ok', latencyMs: 1 },
      ],
      providers: [
        { id: 'copilot', title: 'GitHub Copilot CLI', installed: true },
      ],
    };
    const routes = createSystemHealthRoutes({
      health: { report: async () => report },
    });

    const result = await pick(routes, 'get', '/system-health')(req());

    expect(result).toEqual({ status: 200, body: report });
  });
});
