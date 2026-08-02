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

function routes() {
  return createGithubRoutes({
    githubStatus: () =>
      Promise.resolve({ authenticated: true, login: 'octocat' }),
    githubSignInStart: () =>
      Promise.resolve({
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        deviceCode: 'dev-code',
        interval: 5,
        expiresIn: 900,
      }),
    githubSignInPoll: (deviceCode) =>
      Promise.resolve(
        deviceCode === 'dev-code'
          ? { status: 'success' }
          : { status: 'error', message: 'unknown device' },
      ),
    githubSignOut: () =>
      Promise.resolve({ authenticated: false, login: null }),
  });
}

describe('github-controller', () => {
  it('returns the current GitHub auth status', async () => {
    const result = await pick(routes(), 'get', '/github/status')(req());
    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, login: 'octocat' },
    });
  });

  it('starts a device-flow sign-in', async () => {
    const result = await pick(
      routes(),
      'post',
      '/github/signin/start',
    )(req());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ userCode: 'ABCD-1234' });
  });

  it('polls a device-flow sign-in with the supplied code', async () => {
    const result = await pick(routes(), 'post', '/github/signin/poll')(
      req({ body: { deviceCode: 'dev-code' } }),
    );
    expect(result).toEqual({ status: 200, body: { status: 'success' } });
  });

  it('rejects a poll with no device code', async () => {
    const result = await pick(routes(), 'post', '/github/signin/poll')(
      req({ body: {} }),
    );
    expect(result.status).toBe(400);
  });

  it('defaults a missing poll body to a validation error', async () => {
    const result = await pick(routes(), 'post', '/github/signin/poll')(req());
    expect(result.status).toBe(400);
  });

  it('signs out and returns the resulting status', async () => {
    const result = await pick(routes(), 'post', '/github/signout')(req());
    expect(result).toEqual({
      status: 200,
      body: { authenticated: false, login: null },
    });
  });
});
