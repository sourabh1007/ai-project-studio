import { describe, it, expect } from 'vitest';
import { createMetaPoolsRoutes } from './meta-pools-controller.js';
import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import { ValidationError } from '../kernel/error-types.js';

const status: MetaPoolsStatus = {
  enabled: true,
  model: 'claude-opus-4.8',
  pools: [
    {
      purpose: 'general',
      suggestedSize: 3,
      size: 5,
      live: 5,
      idle: 3,
      busy: 2,
      ready: true,
      served: 12,
      sessions: [],
    },
  ],
};

describe('createMetaPoolsRoutes', () => {
  function routesWith(
    overrides: Partial<Parameters<typeof createMetaPoolsRoutes>[0]> = {},
  ) {
    return createMetaPoolsRoutes({
      status: () => status,
      resize: () => status,
      create: () => status,
      remove: () => status,
      ...overrides,
    });
  }

  it('returns the live warm-pool status', () => {
    const routes = routesWith();
    const route = routes.find((r) => r.method === 'get')!;
    expect(route.path).toBe('/meta/pools');
    expect(route.handler({} as never)).toEqual({ status: 200, body: status });
  });

  it('resizes a pool from the request body and returns the refreshed status', () => {
    const calls: Array<{ purpose: string; size: number }> = [];
    const routes = routesWith({
      resize: (purpose, size) => {
        calls.push({ purpose, size });
        return status;
      },
    });
    const route = routes.find((r) => r.path === '/meta/pools/resize')!;
    expect(route.method).toBe('post');
    const result = route.handler({
      body: { purpose: 'general', size: 3 },
    } as never);
    expect(result).toEqual({ status: 200, body: status });
    expect(calls).toEqual([{ purpose: 'general', size: 3 }]);
  });

  it('creates a pool from the request body and returns the refreshed status', () => {
    const calls: Array<{ purpose: string; size: number }> = [];
    const routes = routesWith({
      create: (purpose, size) => {
        calls.push({ purpose, size });
        return status;
      },
    });
    const route = routes.find((r) => r.path === '/meta/pools/create')!;
    expect(route.method).toBe('post');
    const result = route.handler({
      body: { purpose: 'self-recovery', size: 2 },
    } as never);
    expect(result).toEqual({ status: 200, body: status });
    expect(calls).toEqual([{ purpose: 'self-recovery', size: 2 }]);
  });

  it('removes a pool by purpose and returns the refreshed status', () => {
    const calls: string[] = [];
    const routes = routesWith({
      remove: (purpose) => {
        calls.push(purpose);
        return status;
      },
    });
    const route = routes.find((r) => r.path === '/meta/pools/remove')!;
    expect(route.method).toBe('post');
    const result = route.handler({
      body: { purpose: 'self-recovery' },
    } as never);
    expect(result).toEqual({ status: 200, body: status });
    expect(calls).toEqual(['self-recovery']);
  });

  it('rejects a remove body that is not an object or lacks a purpose', () => {
    const routes = routesWith();
    const route = routes.find((r) => r.path === '/meta/pools/remove')!;
    for (const body of [null, [], 'x', 42]) {
      expect(() => route.handler({ body } as never)).toThrow(ValidationError);
    }
    expect(() => route.handler({ body: { purpose: '  ' } } as never)).toThrow(
      /purpose must be a non-empty string/,
    );
  });

  it('rejects a resize body that is not an object', () => {
    const routes = routesWith();
    const route = routes.find((r) => r.path === '/meta/pools/resize')!;
    for (const body of [null, [], 'x', 42]) {
      expect(() => route.handler({ body } as never)).toThrow(ValidationError);
    }
  });

  it('rejects a resize with a missing or empty purpose', () => {
    const routes = routesWith();
    const route = routes.find((r) => r.path === '/meta/pools/resize')!;
    expect(() => route.handler({ body: { size: 2 } } as never)).toThrow(
      /purpose must be a non-empty string/,
    );
    expect(() =>
      route.handler({ body: { purpose: '  ', size: 2 } } as never),
    ).toThrow(/purpose must be a non-empty string/);
  });

  it('rejects a resize with a non-whole or negative size', () => {
    const routes = routesWith();
    const route = routes.find((r) => r.path === '/meta/pools/resize')!;
    for (const size of [-1, 1.5, 'a', undefined]) {
      expect(() =>
        route.handler({ body: { purpose: 'general', size } } as never),
      ).toThrow(/size must be a whole number/);
    }
  });
});
