import type { PlanUsageService } from '../plan-usage/plan-usage-service.js';
import type { Route } from './http-contract.js';

export interface PlanUsageControllerDeps {
  planUsage: PlanUsageService;
}

/**
 * Route exposing the signed-in Copilot plan's AI-credit budget (used / total /
 * available / reset), scraped from the CLI `/usage` panel.
 *
 * The response is always a state envelope, never a bare `null`: capturing a
 * snapshot takes tens of seconds, so the UI needs to tell "still capturing"
 * apart from "the capture failed" instead of silently hiding the indicator.
 * The read never awaits a capture, so this route always answers immediately.
 */
export function createPlanUsageRoutes(deps: PlanUsageControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/usage/plan',
      handler: () => Promise.resolve({ status: 200, body: deps.planUsage.read() }),
    },
  ];
}
