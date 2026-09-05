import type { SelfHealService } from '../self-heal/self-heal-contract.js';
import type { Route } from './http-contract.js';

export interface SelfHealControllerDeps {
  selfHeal: SelfHealService;
}

/**
 * Route exposing the catalog of problems the IDE can heal on its own (missing
 * CLI, unconfigured model, fixable config). The actual heal run is a streaming
 * SSE endpoint wired in the composition root; this list lets the UI discover
 * what fixes are offered.
 */
export function createSelfHealRoutes(deps: SelfHealControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/self-heal',
      handler: () => ({ status: 200, body: { targets: deps.selfHeal.list() } }),
    },
  ];
}
