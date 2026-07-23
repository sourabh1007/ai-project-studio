import type { FeatureWorkSummaryService } from '../feature/feature-work-summary-contract.js';
import type { Route } from './http-contract.js';

export interface WorkSummaryControllerDeps {
  workSummaries: FeatureWorkSummaryService;
}

/** Route exposing a feature's read-only work summary built from CLI history. */
export function createWorkSummaryRoutes(
  deps: WorkSummaryControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/work-summary',
      handler: (req) => ({
        status: 200,
        body: deps.workSummaries.getByFeature(req.params.featureId),
      }),
    },
  ];
}
