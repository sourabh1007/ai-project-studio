import { NotFoundError } from '../kernel/error-types.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  PrDescriptionGatewayResolver,
  PrDescriptionResult,
  PrDescriptionService,
} from './pr-description-contract.js';
import {
  buildPrReviewSection,
  upsertPrReviewBlock,
} from './pr-description-export.js';
import type { PrReview } from './pr-review-contract.js';

export interface PrDescriptionServiceDeps {
  /** Resolves the review (repo id + pull) whose analysis is being exported. */
  reviews: { get(featureId: string): PrReview | null };
  /** Resolves the repository (for provider + slug) a review targets. */
  repos: { get(id: string): Repository | null };
  /** Builds the provider gateway bound to a repo + pull. */
  gateways: PrDescriptionGatewayResolver;
}

/**
 * Writes a review's problem statement and change-graph diagram into its pull
 * request's description as a managed, idempotent Markdown block — re-running the
 * export updates the block in place instead of appending a duplicate.
 */
export function createPrDescriptionService(
  deps: PrDescriptionServiceDeps,
): PrDescriptionService {
  return {
    async exportToPull(featureId): Promise<PrDescriptionResult> {
      const review = deps.reviews.get(featureId);
      if (!review) {
        throw new NotFoundError(`No PR review for feature ${featureId}`);
      }
      const repo = deps.repos.get(review.repoId);
      if (!repo) {
        throw new NotFoundError(`No repository ${review.repoId}`);
      }
      const gateway = deps.gateways.resolve(repo, review.pull);
      const current = await gateway.getBody();
      const next = upsertPrReviewBlock(current, buildPrReviewSection(review));
      await gateway.setBody(next);
      return { updated: true, url: review.pull.url };
    },
  };
}
