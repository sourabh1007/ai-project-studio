import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type { Route } from './http-contract.js';

export interface AggregateControllerDeps {
  analytics: FeatureAnalyticsService;
}

/** Routes exposing usage rollups for a feature and for the whole workspace. */
export function createAggregateRoutes(deps: AggregateControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/usage',
      handler: (req) => ({
        status: 200,
        body: deps.analytics.forFeature(req.params.featureId),
      }),
    },
    {
      method: 'get',
      path: '/usage/totals',
      handler: () => ({ status: 200, body: deps.analytics.workspaceTotals() }),
    },
    {
      method: 'get',
      path: '/usage/workspace',
      handler: () => ({ status: 200, body: deps.analytics.workspaceStats() }),
    },
  ];
}
