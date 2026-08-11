import { NotFoundError } from '../kernel/error-types.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  PrApprovalGatewayResolver,
  PrApprovalService,
} from './pr-approval-contract.js';
import type { PrReview } from './pr-review-contract.js';

export interface PrApprovalServiceDeps {
  /** Resolves the review (repo id + pull) the approval belongs to. */
  reviews: { get(featureId: string): PrReview | null };
  /** Resolves the repository (for provider + slug) a review targets. */
  repos: { get(id: string): Repository | null };
  /** Builds the provider gateway bound to a repo + pull. */
  gateways: PrApprovalGatewayResolver;
}

/** Resolves a PR review feature to its live pull request and approves it. */
export function createPrApprovalService(
  deps: PrApprovalServiceDeps,
): PrApprovalService {
  return {
    async approve(featureId) {
      const review = deps.reviews.get(featureId);
      if (!review) {
        throw new NotFoundError(`No PR review for feature ${featureId}`);
      }
      const repo = deps.repos.get(review.repoId);
      if (!repo) {
        throw new NotFoundError(`No repository ${review.repoId}`);
      }
      return deps.gateways.resolve(repo, review.pull).approve();
    },
  };
}
