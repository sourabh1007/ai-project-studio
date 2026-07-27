import { describe, it, expect } from 'vitest';
import { createGithubRoutes } from './github-controller.js';
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

describe('github-controller', () => {
  it('returns the current GitHub auth status', async () => {
    const result = await pick(
      createGithubRoutes({
        githubStatus: () =>
          Promise.resolve({ authenticated: true, login: 'octocat' }),
      }),
      'get',
      '/github/status',
    )(req());

    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, login: 'octocat' },
    });
  });
});
