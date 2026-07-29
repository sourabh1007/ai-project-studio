import { describe, it, expect } from 'vitest';
import { createAzureRoutes } from './azure-controller.js';
import type { AzureTarget } from '../azure-auth/azure-devops-auth.js';
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

describe('azure-controller', () => {
  it('status parses the org from the url query and returns the state', async () => {
    let seen: AzureTarget | null = null;
    const result = await pick(
      createAzureRoutes({
        azureStatus: (target) => {
          seen = target;
          return Promise.resolve({ authenticated: true, account: 'alice' });
        },
        azureSignIn: () =>
          Promise.resolve({ authenticated: false, account: null }),
      }),
      'get',
      '/azure-devops/status',
    )(req({ query: { url: 'contoso' } }));

    expect(seen).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, account: 'alice' },
    });
  });

  it('status defaults to the account-level target when no url is given', async () => {
    let seen: AzureTarget | null = null;
    await pick(
      createAzureRoutes({
        azureStatus: (target) => {
          seen = target;
          return Promise.resolve({ authenticated: false, account: null });
        },
        azureSignIn: () =>
          Promise.resolve({ authenticated: false, account: null }),
      }),
      'get',
      '/azure-devops/status',
    )(req());

    expect(seen).toEqual({ host: 'dev.azure.com', org: null });
  });

  it('signin parses the url from the body and triggers sign-in', async () => {
    let seen: AzureTarget | null = null;
    const result = await pick(
      createAzureRoutes({
        azureStatus: () =>
          Promise.resolve({ authenticated: false, account: null }),
        azureSignIn: (target) => {
          seen = target;
          return Promise.resolve({ authenticated: true, account: 'bob' });
        },
      }),
      'post',
      '/azure-devops/signin',
    )(req({ body: { url: 'https://dev.azure.com/contoso/p/_git/r' } }));

    expect(seen).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, account: 'bob' },
    });
  });

  it('signin tolerates a missing body', async () => {
    let seen: AzureTarget | null = null;
    await pick(
      createAzureRoutes({
        azureStatus: () =>
          Promise.resolve({ authenticated: false, account: null }),
        azureSignIn: (target) => {
          seen = target;
          return Promise.resolve({ authenticated: false, account: null });
        },
      }),
      'post',
      '/azure-devops/signin',
    )(req());

    expect(seen).toEqual({ host: 'dev.azure.com', org: null });
  });
});
