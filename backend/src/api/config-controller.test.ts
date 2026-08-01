import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createConfigRoutes } from './config-controller.js';
import { createConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(): HttpRequest {
  return { params: {}, query: {}, body: undefined };
}

describe('config-controller', () => {
  it('exposes namespaces, defaults and current config', async () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: 'demo',
      schema: z.object({ enabled: z.boolean() }),
      defaults: { enabled: true },
    });
    const routes = createConfigRoutes({
      registry,
      current: { demo: { enabled: false } },
      secretPaths: [],
    });
    const result = await pick(routes, 'get', '/config')(req());
    expect(result).toEqual({
      status: 200,
      body: {
        namespaces: ['demo'],
        defaults: { demo: { enabled: true } },
        current: { demo: { enabled: false } },
      },
    });
  });

  it('redacts values at the supplied secret paths', async () => {
    const registry = createConfigSchemaRegistry();
    registry.register({
      namespace: 'demo',
      schema: z.object({ token: z.string() }),
      defaults: { token: '' },
    });
    const routes = createConfigRoutes({
      registry,
      current: { demo: { token: 'super-secret' } },
      secretPaths: ['demo.token'],
    });
    const result = await pick(routes, 'get', '/config')(req());
    expect(result.body).toMatchObject({
      current: { demo: { token: '••••••••' } },
    });
  });
});
