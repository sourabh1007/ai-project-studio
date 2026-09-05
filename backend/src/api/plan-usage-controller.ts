import type { PlanUsageService } from '../plan-usage/plan-usage-service.js';
import type { Route } from './http-contract.js';

export interface PlanUsageControllerDeps {
  planUsage: PlanUsageService;
}

/**
 * Route exposing the signed-in Copilot plan's AI-credit budget (used / total /
 * available / reset), scraped from the CLI `/usage` panel. Returns `200` with a
 * `null` body when no snapshot could be captured yet so the UI can hide the
 * indicator gracefully.
 */
export function createPlanUsageRoutes(deps: PlanUsageControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/usage/plan',
      handler: async () => ({ status: 200, body: await deps.planUsage.read() }),
    },
  ];
}
