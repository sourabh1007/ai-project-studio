import type { PrReviewService } from '../pr-review/pr-review-service.js';
import type { Route } from './http-contract.js';

export interface PrReviewControllerDeps {
  prReviews: PrReviewService;
}

/**
 * Routes for the automated PR review panel: read the current review artifact
 * for a PR review feature, and manually re-run its generation.
 */
export function createPrReviewRoutes(deps: PrReviewControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/pr-review',
      handler: (req) => ({
        status: 200,
        body: deps.prReviews.get(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/refresh',
      handler: (req) => ({
        status: 200,
        body: deps.prReviews.refresh(req.params.featureId),
      }),
    },
  ];
}
