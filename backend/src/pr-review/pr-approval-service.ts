import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import { discoverProjectModel } from '../review-board/project-discovery.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  PrApprovalGatewayResolver,
  PrApprovalService,
  PrApprovalResult,
  PrReviewRevisions,
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
    const run = review.reviewBoardRun;
    if (run && (run.status !== 'completed' || run.headSha !== headSha ||
        run.graphGeneratedAt !== review.changeGraph.generatedAt ||
        run.perspectiveIds.some((id) => !saved?.analyses[id] ||
          saved.analyses[id].runId !== run.id || saved.analyses[id].assessment === 'insufficient-evidence'))) {
      return 'Complete every selected perspective with sufficient evidence for this review run before approving.';
    }
    if (review.changeGraph.status !== 'ready' || !saved ||
        saved.headSha !== headSha || saved.graphGeneratedAt !== review.changeGraph.generatedAt ||
        !(run ? run.perspectiveIds.map((id) => ({ id })) : discoverProjectModel({
          description: review.description,
          changedFiles: review.changedFiles ?? 0,
          projects: review.changeGraph.projects,
          nodes: review.changeGraph.nodes,
        }).perspectives).every(({ id }) => saved.analyses[id])) {
      return 'Complete every Review Board perspective for this commit before approving.';
    }
    return null;
  }

  function targetError(review: PrReview, revisions: PrReviewRevisions | null): string | null {
    const context = review.reviewBoardRun?.context;
    if (context?.baseSha && (!revisions || revisions.baseSha !== context.baseSha ||
        (context.targetBranch !== undefined && revisions.targetBranch !== context.targetBranch))) {
      return 'The target branch or base commit changed or could not be verified. Prepare a fresh review before approving.';
    }
    return null;
  }

  return {
    async revisions(featureId) {
      const { gateway } = resolve(featureId);
      if (!gateway.getRevisions) throw new ValidationError('The provider cannot verify live target revisions.');
      return gateway.getRevisions();
    },
    async status(featureId) {
      const { review, gateway } = resolve(featureId);
      const revisions = review.reviewBoardRun?.context.baseSha && gateway.getRevisions ? await gateway.getRevisions() : null;
      const currentHeadSha = revisions ? revisions.headSha : await gateway.getHeadSha();
      const reason = targetError(review, revisions) ?? approvalError(review, currentHeadSha);
      return { reviewedHeadSha: review.headSha, currentHeadSha, canApprove: reason === null, reason };
    },
    async approve(featureId, expectedHeadSha, expectedReviewUpdatedAt, expectedRunId, expectedAssessmentRevision) {
      const { review, gateway } = resolve(featureId);
      if (!expectedHeadSha || expectedHeadSha !== review.headSha) {
        throw new ValidationError('Approval requires the expected reviewed head SHA.');
      }
      const revision = reviewEvidenceRevision(review);
      const run = review.reviewBoardRun;
      const runId = run?.id;
      const runRevision = run?.revision;
      if (run && (expectedRunId !== run.id || expectedAssessmentRevision !== run.revision)) {
        throw new ValidationError('The review run or assessment changed. Reload before approving.');
      }
      if (expectedReviewUpdatedAt !== undefined && expectedReviewUpdatedAt !== revision) {
        throw new ValidationError('Review evidence changed since confirmation. Reload the reviewed results before approving.');
      }
      const reason = approvalError(review, expectedHeadSha);
      if (reason) throw new ValidationError(reason);
      const key = `${review.repoId}:${review.pull.number}:${expectedHeadSha}:${run?.id ?? ''}:${run?.revision ?? ''}`;
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        const revisions = run?.context.baseSha && gateway.getRevisions ? await gateway.getRevisions() : null;
        const liveHead = revisions ? revisions.headSha : await gateway.getHeadSha();
        const current = resolve(featureId).review;
        const changed = targetError(current, revisions) ?? approvalError(current, liveHead);
        if (current.headSha !== expectedHeadSha || reviewEvidenceRevision(current) !== revision || changed ||
            current.reviewBoardRun?.id !== runId || current.reviewBoardRun?.revision !== runRevision) {
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
