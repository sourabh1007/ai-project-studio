import type { HealthReportService } from '../health/health-contract.js';
import type { Route } from './http-contract.js';

export interface SystemHealthControllerDeps {
  health: HealthReportService;
}

/**
 * Route exposing the aggregated system-health report — the status of each
 * backend subsystem the app depends on plus each configured AI provider — so the
 * Settings ▸ Health page can show what is up or down and offer recovery. Unlike
 * the cheap `/health` liveness probe, this fans out to the registered subsystem
 * probes (each bounded by a timeout), so it is an explicit on-demand check.
 */
export function createSystemHealthRoutes(
  deps: SystemHealthControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/system-health',
      handler: async () => ({ status: 200, body: await deps.health.report() }),
    },
  ];
}
