import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import type { Route } from './http-contract.js';

export interface MetaPoolsControllerDeps {
  /** Live warm-pool status snapshot (enabled + per-purpose capacity). */
  status: () => MetaPoolsStatus;
}

/**
 * Read-only route exposing the warm metasession pools so the Settings page can
 * show how much warm AI capacity is ready. Purely reflects live pool state.
 */
export function createMetaPoolsRoutes(deps: MetaPoolsControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/meta/pools',
      handler: () => ({ status: 200, body: deps.status() }),
    },
  ];
}
