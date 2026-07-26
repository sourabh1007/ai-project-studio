import { describe, it, expect } from 'vitest';
import { createAgencyRoutes } from './agency-controller.js';
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

describe('agency-controller', () => {
  it('returns the current agency install status', async () => {
    const result = await pick(
      createAgencyRoutes({ agencyStatus: () => ({ installed: true }) }),
      'get',
      '/agency/status',
    )(req());

    expect(result).toEqual({ status: 200, body: { installed: true } });
  });
});
