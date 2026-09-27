import type { Route } from './http-contract.js';
import type { ResourceSnapshot } from '../resource-pressure/resource-pressure.js';

/** Payload returned by the lightweight liveness probe. */
export interface HealthStatus {
  status: 'ok';
  uptimeMs: number;
  resources?: ResourceSnapshot;
}

export interface HealthControllerDeps {
  /** Monotonic clock in milliseconds; injectable so uptime is testable. */
  now?: () => number;
  /** Process start time in the same clock as {@link HealthControllerDeps.now}. */
  startedAt?: number;
  /** Cached sampler output only: no sampling or subsystem fan-out during a probe. */
  resources?: () => ResourceSnapshot;
}

/**
 * A tiny, dependency-free liveness endpoint the UI polls to distinguish a
 * genuine backend outage from the browser simply being offline. It must stay
 * cheap: no I/O, no auth, no subsystem fan-out.
 */
export function createHealthRoutes(deps: HealthControllerDeps = {}): Route[] {
  const now = deps.now ?? (() => Date.now());
  const startedAt = deps.startedAt ?? now();
  return [
    {
      method: 'get',
      path: '/health',
      handler: () => ({
        status: 200,
        body: {
          status: 'ok', uptimeMs: Math.max(0, now() - startedAt),
          ...(deps.resources ? { resources: deps.resources() } : {}),
        },
      }),
    },
  ];
}
