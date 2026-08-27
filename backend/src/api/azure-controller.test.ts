import { describe, it, expect } from 'vitest';
import { createAzureRoutes, type AzureControllerDeps } from './azure-controller.js';
import type {
  AzureDevOpsStatus,
  AzureTarget,
} from '../azure-auth/azure-devops-auth.js';
import type { HttpRequest, Route } from './http-contract.js';

const unauthenticated: AzureDevOpsStatus = {
  authenticated: false,
  account: null,
  message: null,
};

function deps(overrides: Partial<AzureControllerDeps> = {}): AzureControllerDeps {
  return {
    azureStatus: () => Promise.resolve(unauthenticated),
    azureSignIn: () => Promise.resolve(unauthenticated),
    azureSignOut: () => Promise.resolve(unauthenticated),
    ...overrides,
  };
}

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
      createAzureRoutes(
        deps({
          azureStatus: (target) => {
            seen = target;
            return Promise.resolve({
              authenticated: true,
              account: 'alice',
              message: null,
            });
          },
        }),
      ),
      'get',
      '/azure-devops/status',
    )(req({ query: { url: 'contoso' } }));

    expect(seen).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, account: 'alice', message: null },
    });
  });

  it('status defaults to the account-level target when no url is given', async () => {
    let seen: AzureTarget | null = null;
    await pick(
      createAzureRoutes(
        deps({
          azureStatus: (target) => {
            seen = target;
            return Promise.resolve(unauthenticated);
          },
        }),
      ),
      'get',
      '/azure-devops/status',
    )(req());

    expect(seen).toEqual({ host: 'dev.azure.com', org: null });
  });

  it('signin parses the url from the body and triggers sign-in', async () => {
    let seen: AzureTarget | null = null;
    const result = await pick(
      createAzureRoutes(
        deps({
          azureSignIn: (target) => {
            seen = target;
            return Promise.resolve({
              authenticated: true,
              account: 'bob',
              message: null,
            });
          },
        }),
      ),
      'post',
      '/azure-devops/signin',
    )(req({ body: { url: 'https://dev.azure.com/contoso/p/_git/r' } }));

    expect(seen).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(result).toEqual({
      status: 200,
      body: { authenticated: true, account: 'bob', message: null },
    });
  });

  it('signin tolerates a missing body', async () => {
    let seen: AzureTarget | null = null;
    await pick(
      createAzureRoutes(
        deps({
          azureSignIn: (target) => {
            seen = target;
            return Promise.resolve(unauthenticated);
          },
        }),
      ),
      'post',
      '/azure-devops/signin',
    )(req());

    expect(seen).toEqual({ host: 'dev.azure.com', org: null });
  });

  it('signout parses the url from the body and erases the credential', async () => {
    let seen: AzureTarget | null = null;
    const result = await pick(
      createAzureRoutes(
        deps({
          azureSignOut: (target) => {
            seen = target;
            return Promise.resolve(unauthenticated);
          },
        }),
      ),
      'post',
      '/azure-devops/signout',
    )(req({ body: { url: 'contoso' } }));

    expect(seen).toEqual({ host: 'dev.azure.com', org: 'contoso' });
    expect(result).toEqual({ status: 200, body: unauthenticated });
  });

  it('signout tolerates a missing body', async () => {
    let seen: AzureTarget | null = null;
    await pick(
      createAzureRoutes(
        deps({
          azureSignOut: (target) => {
            seen = target;
            return Promise.resolve(unauthenticated);
          },
        }),
      ),
      'post',
      '/azure-devops/signout',
    )(req());

    expect(seen).toEqual({ host: 'dev.azure.com', org: null });
  });
});
