import type { ReviewBoardService } from '../review-board/review-board-contract.js';
import type { Route } from './http-contract.js';

export interface ReviewBoardControllerDeps {
  reviewBoard: ReviewBoardService;
}

/**
 * Route for the Project Review Board page: derive and return the dynamic,
 * evidence-based review board for a review feature. The board is computed on
 * demand from the feature's existing PR review, so a missing review surfaces as
 * the same not-found error the PR review page uses.
 */
export function createReviewBoardRoutes(
  deps: ReviewBoardControllerDeps,
): Route[] {
  return [
    {
      method: 'get',
      path: '/features/:featureId/review-board',
      handler: (req) => ({
        status: 200,
        body: deps.reviewBoard.get(req.params.featureId),
      }),
    },
  ];
}
