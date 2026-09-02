import { describe, it, expect } from 'vitest';
import { createMetaPoolsRoutes } from './meta-pools-controller.js';
import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';

describe('createMetaPoolsRoutes', () => {
  it('returns the live warm-pool status', () => {
    const status: MetaPoolsStatus = {
      enabled: true,
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
    const routes = createMetaPoolsRoutes({ status: () => status });
    const route = routes[0];
    expect(route.method).toBe('get');
    expect(route.path).toBe('/meta/pools');
    expect(route.handler({} as never)).toEqual({ status: 200, body: status });
  });
});
