import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  AddPrCommentInput,
  PrCommentThread,
  PrCommentThreadStatus,
  PrCommentsGatewayResolver,
  PrCommentsService,
} from './pr-comments-contract.js';
import type { PrReview } from './pr-review-contract.js';
import { assertExpectedHeadSha, hasCapturedRightLine, isRepoRelativePath } from './pr-comment-location.js';

export interface PrCommentsServiceDeps {
  /** Resolves the review (repo id + pull) a feature's comments belong to. */
  reviews: { get(featureId: string): PrReview | null };
  /** Resolves the repository (for provider + slug) a review targets. */
  repos: { get(id: string): Repository | null };
  /** Builds the provider gateway bound to a repo + pull. */
  gateways: PrCommentsGatewayResolver;
}

const VALID_STATUSES: PrCommentThreadStatus[] = ['active', 'resolved'];

/** Validates a thread status supplied by the client. */
export function assertThreadStatus(value: string): PrCommentThreadStatus {
  if ((VALID_STATUSES as string[]).includes(value)) {
    return value as PrCommentThreadStatus;
  }
  throw new ValidationError(
    `Unknown thread status "${value}"; expected "active" or "resolved".`,
  );
}

/** Validates an inline comment payload from a request body. */
export function assertAddCommentInput(body: unknown): AddPrCommentInput {
  const raw = (body ?? {}) as {
    path?: unknown;
    line?: unknown;
    body?: unknown;
    expectedHeadSha?: unknown;
  };
  if (typeof raw.body !== 'string' || raw.body.trim().length === 0) {
    throw new ValidationError('A non-empty comment "body" is required.');
  }
  const hasPath = raw.path !== undefined && raw.path !== null;
  const hasLine = raw.line !== undefined && raw.line !== null;
  if (hasPath !== hasLine) {
    throw new ValidationError(
      'Provide both "path" and "line" to anchor a comment, or neither for a PR-level comment.',
    );
  }
  if (hasPath) {
    if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
      throw new ValidationError('A non-empty file "path" is required.');
    }
    if (
      typeof raw.line !== 'number' ||
      !Number.isInteger(raw.line) ||
      raw.line < 1
    ) {
      throw new ValidationError('A positive integer "line" is required.');
    }
  }
  if (raw.expectedHeadSha !== undefined) {
    assertExpectedHeadSha(raw.expectedHeadSha);
    if (!hasPath) {
      throw new ValidationError(
        'A head-guarded comment must be anchored to a "path" and "line".',
      );
    }
  }
  return {
    body: raw.body,
    ...(hasPath ? { path: raw.path as string, line: raw.line as number } : {}),
    ...(raw.expectedHeadSha !== undefined ? { expectedHeadSha: raw.expectedHeadSha } : {}),
  };
}

/**
 * Resolves a review + its repository into a provider gateway, dispatching every
 * comment operation to the live pull request. Kept pure (no provider SDKs) — the
 * composition root supplies the gateway resolver — so it is fully unit-tested.
 */
export function createPrCommentsService(
  deps: PrCommentsServiceDeps,
): PrCommentsService {
  const gatewayFor = (
    featureId: string,
    guardedInput?: AddPrCommentInput & { path: string; line: number },
  ) => {
    const review = deps.reviews.get(featureId);
    if (!review) {
      throw new NotFoundError(`No code review for feature ${featureId}`);
    }
    if (guardedInput) {
      if (!review.headSha || review.headSha !== guardedInput.expectedHeadSha) {
        throw new ValidationError('The captured review head has changed or is missing. Refresh the Review Board before posting.');
      }
      if (review.changeGraph.status !== 'ready') {
        throw new ValidationError('The captured change graph is not ready. Refresh the Review Board before posting.');
      }
      const node = review.changeGraph.nodes.find((candidate) =>
        candidate.path === guardedInput.path && candidate.kind === 'changed');
      if (!isRepoRelativePath(guardedInput.path) || !node ||
          node.changeKind === 'deleted' || !hasCapturedRightLine(node.diff, guardedInput.line)) {
        throw new ValidationError('The exact file and RIGHT-side line are not present in the captured diff. Refresh the Review Board before posting.');
      }
    }
    const repo = deps.repos.get(review.repoId);
    if (!repo) {
      throw new NotFoundError(`No repository ${review.repoId}`);
    }
    return deps.gateways.resolve(repo, review.pull);
  };

  return {
    async list(featureId) {
      return gatewayFor(featureId).list();
    },
    async add(featureId, input): Promise<PrCommentThread> {
      if (input.expectedHeadSha !== undefined) {
        const validated = assertAddCommentInput(input);
        // assertAddCommentInput requires an anchor whenever a head guard is set.
        return gatewayFor(
          featureId,
          validated as AddPrCommentInput & { path: string; line: number },
        ).add(validated);
      }
      return gatewayFor(featureId).add(input);
    },
    async setStatus(featureId, threadId, status): Promise<PrCommentThread> {
      if (typeof threadId !== 'string' || threadId.trim().length === 0) {
        throw new ValidationError('A non-empty "threadId" is required.');
      }
      return gatewayFor(featureId).setStatus(threadId, status);
    },
  };
}
