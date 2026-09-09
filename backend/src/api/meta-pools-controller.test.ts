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

  describe('process admission stamping', () => {
    const admission: NonNullable<MetaPoolsStatus['processAdmission']> = {
      processes: 3,
      warmProcesses: 3,
      queued: 0,
      closed: false,
      maxProcesses: 16,
      maxWarmProcesses: 12,
      maxQueued: 32,
    };

    /** The four routes and a body each accepts. */
    const cases = [
      { path: '/meta/pools', body: undefined },
      { path: '/meta/pools/resize', body: { purpose: 'general', size: 3 } },
      { path: '/meta/pools/create', body: { purpose: 'review', size: 2 } },
      { path: '/meta/pools/remove', body: { purpose: 'review' } },
    ];

    it.each(cases)(
      'stamps the live process budget onto $path',
      ({ path, body }) => {
        const routes = routesWith({ processAdmission: () => admission });
        const route = routes.find((r) => r.path === path)!;
        expect(route.handler({ body } as never)).toEqual({
          status: 200,
          body: { ...status, processAdmission: admission },
        });
      },
    );

    it('reads the budget per request so a response is never stale', () => {
      let processes = 1;
      const routes = routesWith({
        processAdmission: () => ({ ...admission, processes }),
      });
      const route = routes.find((r) => r.path === '/meta/pools')!;
      const first = route.handler({} as never) as { body: MetaPoolsStatus };
      processes = 7;
      const second = route.handler({} as never) as { body: MetaPoolsStatus };
      expect(first.body.processAdmission?.processes).toBe(1);
      expect(second.body.processAdmission?.processes).toBe(7);
    });

    it.each(cases)(
      'omits the budget on $path when no admission gate is wired',
      ({ path, body }) => {
        const routes = routesWith();
        const route = routes.find((r) => r.path === path)!;
        const result = route.handler({ body } as never) as { body: MetaPoolsStatus };
        expect(result.body).toEqual(status);
        expect(result.body.processAdmission).toBeUndefined();
      },
    );

    it('does not let a status that already carries a budget override the live one', () => {
      const stale = { ...status, processAdmission: { ...admission, processes: 99 } };
      const routes = routesWith({
        status: () => stale,
        processAdmission: () => admission,
      });
      const route = routes.find((r) => r.path === '/meta/pools')!;
      const result = route.handler({} as never) as { body: MetaPoolsStatus };
      expect(result.body.processAdmission).toEqual(admission);
    });
  });
});
