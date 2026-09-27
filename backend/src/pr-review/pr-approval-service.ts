import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import { discoverProjectModel } from '../review-board/project-discovery.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  PrApprovalGatewayResolver,
  PrApprovalService,
  PrApprovalResult,
} from './pr-approval-contract.js';
import type { PrReview } from './pr-review-contract.js';
import { reviewEvidenceRevision } from './pr-review-contract.js';

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
  const pending = new Map<string, Promise<PrApprovalResult>>();
  function resolve(featureId: string) {
      const review = deps.reviews.get(featureId);
      if (!review) {
        throw new NotFoundError(`No code review for feature ${featureId}`);
      }
      const repo = deps.repos.get(review.repoId);
      if (!repo) {
        throw new NotFoundError(`No repository ${review.repoId}`);
      }
      return { review, gateway: deps.gateways.resolve(repo, review.pull) };
  }

  function approvalError(review: PrReview, headSha: string): string | null {
    if (!review.headSha || review.headSha !== headSha) {
      return 'The pull request head changed. Reset explicitly to review the latest commit before approving.';
    }
    const saved = review.reviewBoardAnalysis;
    if (review.changeGraph.status !== 'ready' || !saved ||
        saved.headSha !== headSha || saved.graphGeneratedAt !== review.changeGraph.generatedAt ||
        !discoverProjectModel({
          description: review.description,
          changedFiles: review.changedFiles ?? 0,
          projects: review.changeGraph.projects,
          nodes: review.changeGraph.nodes,
        }).perspectives.every(({ id }) => saved.analyses[id])) {
      return 'Complete every Review Board perspective for this commit before approving.';
    }
    return null;
  }

  return {
    async status(featureId) {
      const { review, gateway } = resolve(featureId);
      const currentHeadSha = await gateway.getHeadSha();
      const reason = approvalError(review, currentHeadSha);
      return { reviewedHeadSha: review.headSha, currentHeadSha, canApprove: reason === null, reason };
    },
    async approve(featureId, expectedHeadSha, expectedReviewUpdatedAt) {
      const { review, gateway } = resolve(featureId);
      if (!expectedHeadSha || expectedHeadSha !== review.headSha) {
        throw new ValidationError('Approval requires the expected reviewed head SHA.');
      }
      const revision = reviewEvidenceRevision(review);
      if (expectedReviewUpdatedAt !== undefined && expectedReviewUpdatedAt !== revision) {
        throw new ValidationError('Review evidence changed since confirmation. Reload the reviewed results before approving.');
      }
      const reason = approvalError(review, expectedHeadSha);
      if (reason) throw new ValidationError(reason);
      const key = `${review.repoId}:${review.pull.number}:${expectedHeadSha}`;
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const liveHead = await gateway.getHeadSha();
        const current = resolve(featureId).review;
        const changed = approvalError(current, liveHead);
        if (current.headSha !== expectedHeadSha || reviewEvidenceRevision(current) !== revision || changed) {
          throw new ValidationError(changed ?? 'Review changed while confirming approval.');
        }
        return gateway.approve(expectedHeadSha);
      })();
      pending.set(key, operation);
      try {
        return await operation;
      } finally {
        pending.delete(key);
      }
    },
  };
}
