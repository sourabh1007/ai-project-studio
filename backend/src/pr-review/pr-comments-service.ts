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
  };
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
  if (typeof raw.body !== 'string' || raw.body.trim().length === 0) {
    throw new ValidationError('A non-empty comment "body" is required.');
  }
  return { path: raw.path, line: raw.line, body: raw.body };
}

/**
 * Resolves a review + its repository into a provider gateway, dispatching every
 * comment operation to the live pull request. Kept pure (no provider SDKs) — the
 * composition root supplies the gateway resolver — so it is fully unit-tested.
 */
export function createPrCommentsService(
  deps: PrCommentsServiceDeps,
): PrCommentsService {
  const gatewayFor = (featureId: string) => {
    const review = deps.reviews.get(featureId);
    if (!review) {
      throw new NotFoundError(`No PR review for feature ${featureId}`);
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
