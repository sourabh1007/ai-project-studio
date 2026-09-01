import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createConfigRoutes } from './config-controller.js';
import { createConfigSchemaRegistry } from '../config/config-schema-registry.js';
import {
  createConfigOverrideService,
  type ConfigOverrideService,
} from '../config/config-override-service.js';
import type {
  ConfigOverrideRecord,
  ConfigOverrideStore,
} from '../config/config-override-store.js';
import { createClock } from '../kernel/clock.js';
import { ValidationError, NotFoundError } from '../kernel/error-types.js';
import type { ConfigObject } from '../config/config-contract.js';
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

function inMemoryStore(): ConfigOverrideStore {
  const rows = new Map<string, ConfigOverrideRecord>();
  return {
    all: () => [...rows.values()],
    get: (namespace) => rows.get(namespace) ?? null,
    set: (record) => {
      rows.set(record.namespace, record);
    },
    delete: (namespace) => {
      rows.delete(namespace);
    },
  };
}

function setup(current: ConfigObject = { demo: { enabled: false } }): {
  routes: Route[];
  overrides: ConfigOverrideService;
} {
  const registry = createConfigSchemaRegistry();
  registry.register({
    namespace: 'demo',
    schema: z.object({ enabled: z.boolean(), label: z.string() }),
    defaults: { enabled: true, label: 'default' },
  });
  const overrides = createConfigOverrideService({
    store: inMemoryStore(),
    registry,
    clock: createClock(() => 0),
  });
  const routes = createConfigRoutes({
    registry,
    current,
    secretPaths: [],
    overrides,
  });
  return { routes, overrides };
}

describe('config-controller', () => {
  it('exposes namespaces, defaults, current config and overrides', async () => {
    const { routes, overrides } = setup();
    overrides.update('demo', { label: 'custom' });
    const result = await pick(routes, 'get', '/config')(req());
    expect(result).toEqual({
      status: 200,
      body: {
        namespaces: ['demo'],
        defaults: { demo: { enabled: true, label: 'default' } },
        schema: {
          demo: {
            kind: 'object',
            fields: {
              enabled: { kind: 'boolean' },
              label: { kind: 'string' },
            },
          },
        },
        current: { demo: { enabled: false } },
        overrides: { demo: { label: 'custom' } },
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
    const overrides = createConfigOverrideService({
      store: inMemoryStore(),
      registry,
      clock: createClock(() => 0),
    });
    const routes = createConfigRoutes({
      registry,
      current: { demo: { token: 'super-secret' } },
      secretPaths: ['demo.token'],
      overrides,
    });
    const result = await pick(routes, 'get', '/config')(req());
    expect(result.body).toMatchObject({
      current: { demo: { token: '••••••••' } },
    });
  });

  it('persists a namespace override via PUT', async () => {
    const { routes, overrides } = setup();
    const result = await pick(
      routes,
      'put',
      '/config/:namespace',
    )(
      req({
        params: { namespace: 'demo' },
        body: { values: { enabled: false } },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      namespace: 'demo',
      effective: { enabled: false, label: 'default' },
      override: { enabled: false },
      requiresRestart: true,
    });
    expect(overrides.getOverride('demo')).toEqual({ enabled: false });
  });

  it('rejects an invalid PUT body', () => {
    const { routes } = setup();
    expect(() =>
      pick(routes, 'put', '/config/:namespace')(
        req({ params: { namespace: 'demo' }, body: {} }),
      ),
    ).toThrow(ValidationError);
  });

  it('rejects a PUT to an unknown namespace', () => {
    const { routes } = setup();
    expect(() =>
      pick(routes, 'put', '/config/:namespace')(
        req({ params: { namespace: 'nope' }, body: { values: {} } }),
      ),
    ).toThrow(NotFoundError);
  });

  it('resets a namespace via DELETE', async () => {
    const { routes, overrides } = setup();
    overrides.update('demo', { enabled: false });
    const result = await pick(
      routes,
      'delete',
      '/config/:namespace',
    )(req({ params: { namespace: 'demo' } }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      namespace: 'demo',
      override: {},
      requiresRestart: true,
    });
    expect(overrides.getOverride('demo')).toEqual({});
  });
});
