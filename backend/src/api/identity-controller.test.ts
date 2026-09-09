import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdentityRoutes,
  DESKTOP_PROTOCOL_VERSION,
  type BackendIdentity,
} from './identity-controller.js';
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

async function identity(deps?: Parameters<typeof createIdentityRoutes>[0]) {
  const result = await pick(createIdentityRoutes(deps), 'get', '/identity')(req());
  return result.body as BackendIdentity;
}

describe('identity-controller', () => {
  const original = {
    launchId: process.env.CW_DESKTOP_LAUNCH_ID,
    version: process.env.CW_APP_VERSION,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries({
      CW_DESKTOP_LAUNCH_ID: original.launchId,
      CW_APP_VERSION: original.version,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('echoes the injected launch identity with the protocol version', async () => {
    const result = await pick(
      createIdentityRoutes({ launchId: 'launch-1', pid: 4242, version: '0.11.3' }),
      'get',
      '/identity',
    )(req());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      launchId: 'launch-1',
      pid: 4242,
      version: '0.11.3',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    });
  });

  it('falls back to the launch environment the desktop shell provides', async () => {
    process.env.CW_DESKTOP_LAUNCH_ID = 'from-env';
    process.env.CW_APP_VERSION = '9.9.9';
    expect(await identity()).toEqual({
      launchId: 'from-env',
      pid: process.pid,
      version: '9.9.9',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    });
  });

  it('reports no launch id and an unknown version outside the desktop shell', async () => {
    delete process.env.CW_DESKTOP_LAUNCH_ID;
    delete process.env.CW_APP_VERSION;
    expect(await identity()).toEqual({
      launchId: null,
      pid: process.pid,
      version: 'unknown',
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
    });
  });
});
