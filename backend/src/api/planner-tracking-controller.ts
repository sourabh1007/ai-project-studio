import { z } from 'zod';
import type { WorkTracker, WorkTrackingStore } from '../planner-tracking/tracking-contract.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

export interface PlannerTrackingRoutesDeps {
  tracker: WorkTracker;
  store: Pick<WorkTrackingStore, 'provenance'>;
}
export function createPlannerTrackingRoutes(deps: PlannerTrackingRoutesDeps): Route[] {
  return [
    { method: 'get', path: '/planner/tracking', handler: () => ({ status: 200, body: deps.tracker.status() }) },
    {
      method: 'put', path: '/planner/tracking', handler: (req) => ({
        status: 200, body: deps.tracker.setEnabled(parseInput(z.object({ enabled: z.boolean() }), req.body).enabled),
      }),
    },
    {
      method: 'get', path: '/planner/tasks/:taskId/evidence',
      handler: (req) => ({ status: 200, body: deps.store.provenance(req.params.taskId) }),
    },
  ];
}
