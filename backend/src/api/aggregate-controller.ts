import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type { UsageSummary } from '../usage-summary/usage-summary-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

export interface AggregateControllerDeps {
  analytics: FeatureAnalyticsService;
  summary?: (signal?: AbortSignal) => Promise<UsageSummary>;
}

/** Routes exposing usage rollups for a feature and for the whole workspace. */
export function createAggregateRoutes(deps: AggregateControllerDeps): Route[] {
  const summary = deps.summary;
  return [
    ...(summary ? [{
      method: 'get' as const,
      path: '/usage/summary',
      handler: async (req: HttpRequest) => ({
        status: 200,
        body: await summary(req.signal),
      }),
    }] : []),
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
