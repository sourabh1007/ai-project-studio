import type { PrReviewService } from '../pr-review/pr-review-service.js';
import type { PrReviewStepKey } from '../pr-review/pr-review-contract.js';
import type { PrCommentsService } from '../pr-review/pr-comments-contract.js';
import {
  assertAddCommentInput,
  assertThreadStatus,
} from '../pr-review/pr-comments-service.js';
import { ValidationError } from '../kernel/error-types.js';
import type { Route } from './http-contract.js';

export interface PrReviewControllerDeps {
  prReviews: PrReviewService;
  prComments: PrCommentsService;
}

const STEP_KEYS: PrReviewStepKey[] = ['problemStatement', 'changeGraph'];

function assertStep(value: string): PrReviewStepKey {
  if ((STEP_KEYS as string[]).includes(value)) {
    return value as PrReviewStepKey;
  }
  throw new ValidationError(`Unknown PR review step: ${value}`);
}

/** Reads and validates the `path` of the file to explain from a request body. */
function assertPath(body: unknown): string {
  const path = (body as { path?: unknown })?.path;
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new ValidationError('A non-empty file "path" is required.');
  }
  return path;
}

/**
 * Routes for the multi-step PR review page: read the current review artifact for
 * a PR review feature, re-run every step, or retry a single step.
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
    {
      method: 'post',
      path: '/features/:featureId/pr-review/steps/:step/retry',
      handler: (req) => ({
        status: 200,
        body: deps.prReviews.retryStep(
          req.params.featureId,
          assertStep(req.params.step),
        ),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/files/explain',
      handler: async (req) => ({
        status: 200,
        body: await deps.prReviews.explainFile(
          req.params.featureId,
          assertPath(req.body),
        ),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/pr-review/comments',
      handler: async (req) => ({
        status: 200,
        body: await deps.prComments.list(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/comments',
      handler: async (req) => ({
        status: 200,
        body: await deps.prComments.add(
          req.params.featureId,
          assertAddCommentInput(req.body),
        ),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/comments/:threadId/status',
      handler: async (req) => ({
        status: 200,
        body: await deps.prComments.setStatus(
          req.params.featureId,
          req.params.threadId,
          assertThreadStatus(assertStatusBody(req.body)),
        ),
      }),
    },
  ];
}

/** Reads and validates the `status` string from a set-status request body. */
function assertStatusBody(body: unknown): string {
  const status = (body as { status?: unknown })?.status;
  if (typeof status !== 'string' || status.trim().length === 0) {
    throw new ValidationError('A non-empty "status" is required.');
  }
  return status;
}
