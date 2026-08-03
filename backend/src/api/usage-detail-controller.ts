import type { UsageDetailService } from '../usage-detail/usage-detail-service.js';
import type { Route } from './http-contract.js';

export interface UsageDetailControllerDeps {
  usageDetail: UsageDetailService;
}

/**
 * Routes exposing the per-turn usage breakdown (every credit/token event) for a
 * single session, a whole feature, or an entire repository. These back the UI
 * "how is each credit and token being used" drill-down.
 */
export function createUsageDetailRoutes(
  deps: UsageDetailControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/sessions/:sessionId/usage',
      handler: (req) => ({
        status: 200,
        body: deps.usageDetail.forSession(req.params.sessionId),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/usage/events',
      handler: (req) => ({
        status: 200,
        body: deps.usageDetail.forFeature(req.params.featureId),
      }),
    },
    {
      method: 'get',
      path: '/repos/:repoId/usage/events',
      handler: (req) => ({
        status: 200,
        body: deps.usageDetail.forRepo(req.params.repoId),
      }),
    },
  ];
}
