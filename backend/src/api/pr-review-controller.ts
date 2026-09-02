import type { PrReviewService } from '../pr-review/pr-review-service.js';
import type { PrFeatureService } from '../repo/pr-feature-service.js';
import type {
  ChangeGraphCategory,
  PrReviewChatMessage,
  PrReviewStepKey,
} from '../pr-review/pr-review-contract.js';
import type { PrCommentsService } from '../pr-review/pr-comments-contract.js';
import type { PrApprovalService } from '../pr-review/pr-approval-contract.js';
import type { PrDescriptionService } from '../pr-review/pr-description-contract.js';
import {
  assertAddCommentInput,
  assertThreadStatus,
} from '../pr-review/pr-comments-service.js';
import { ValidationError } from '../kernel/error-types.js';
import type { Route } from './http-contract.js';

export interface PrReviewControllerDeps {
  prReviews: PrReviewService;
  prComments: PrCommentsService;
  prApprovals: PrApprovalService;
  prDescriptions: PrDescriptionService;
  /** Owns re-provisioning the worktree from the remote for "take latest". */
  prFeatures: Pick<PrFeatureService, 'pullLatest'>;
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

/** Reads and validates the `path` query parameter of a file-content request. */
function assertQueryPath(query: Record<string, string | undefined>): string {
  const path = query.path;
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new ValidationError('A non-empty file "path" query is required.');
  }
  return path;
}

const CATEGORIES: ChangeGraphCategory[] = ['code', 'test'];

/** Validates and extracts the `{ category, messages }` of a graph-chat request. */
function assertGraphChat(body: unknown): {
  category: ChangeGraphCategory;
  messages: PrReviewChatMessage[];
} {
  const category = (body as { category?: unknown })?.category;
  if (typeof category !== 'string' || !(CATEGORIES as string[]).includes(category)) {
    throw new ValidationError('A "category" of "code" or "test" is required.');
  }
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('A non-empty "messages" array is required.');
  }
  const messages = raw.map((m) => {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (
      (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      throw new ValidationError(
        'Each message needs a "role" of "user"/"assistant" and non-empty "content".',
      );
    }
    return { role: role as 'user' | 'assistant', content };
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new ValidationError('The last message must be from the reviewer.');
  }
  return { category: category as ChangeGraphCategory, messages };
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
      path: '/features/:featureId/pr-review/pull-latest',
      handler: async (req) => ({
        status: 200,
        body: await deps.prFeatures.pullLatest(req.params.featureId),
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
      path: '/features/:featureId/pr-review/files/content',
      handler: async (req) => ({
        status: 200,
        body: await deps.prReviews.getFileContent(
          req.params.featureId,
          assertQueryPath(req.query),
        ),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/graph-chat',
      handler: async (req) => {
        const { category, messages } = assertGraphChat(req.body);
        return {
          status: 200,
          body: await deps.prReviews.chatAboutGraph(
            req.params.featureId,
            category,
            messages,
          ),
        };
      },
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/approve',
      handler: async (req) => ({
        status: 200,
        body: await deps.prApprovals.approve(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/pr-review/export-description',
      handler: async (req) => ({
        status: 200,
        body: await deps.prDescriptions.exportToPull(req.params.featureId),
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
