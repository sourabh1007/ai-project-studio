import { ValidationError } from '../kernel/error-types.js';
import type {
  ReviewBoardChatContext,
  ReviewBoardChatMessage,
  ReviewBoardService,
} from '../review-board/review-board-contract.js';
import type { Route } from './http-contract.js';
import type { ReviewBoardQueue } from '../review-board/review-board-queue.js';
import { parseFindingAction, parseReviewOptions } from '../review-board/review-run.js';

export interface ReviewBoardControllerDeps {
  prComments?: import('../pr-review/pr-comments-contract.js').PrCommentsService;
  reviewBoard: ReviewBoardService;
  reviewQueue?: ReviewBoardQueue;
}

/**
 * Defensively parse the optional analysed-perspective `context` a client may
 * attach so the agent sees the on-screen findings. Anything malformed is
 * dropped to null rather than rejected — the chat still works without it.
 */
function parseChatContext(raw: unknown): ReviewBoardChatContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const { status, risk, findings } = raw as Record<string, unknown>;
  if (typeof status !== 'string' || typeof risk !== 'string') return null;
  if (!Array.isArray(findings)) return null;
  return {
    status: status as ReviewBoardChatContext['status'],
    risk: risk as ReviewBoardChatContext['risk'],
    findings: findings as ReviewBoardChatContext['findings'],
  };
}

/** Validates and extracts the `{ perspectiveId, messages }` of a chat request. */
function assertChat(body: unknown): {
  perspectiveId: string | null;
  messages: ReviewBoardChatMessage[];
  context: ReviewBoardChatContext | null;
} {
  const rawPerspective = (body as { perspectiveId?: unknown })?.perspectiveId;
  if (
    rawPerspective !== undefined &&
    rawPerspective !== null &&
    typeof rawPerspective !== 'string'
  ) {
    throw new ValidationError('"perspectiveId" must be a string or null.');
  }
  const perspectiveId =
    typeof rawPerspective === 'string' ? rawPerspective : null;
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
  const context = parseChatContext(
    (body as { context?: unknown })?.context,
  );
  return { perspectiveId, messages, context };
}

/**
 * Routes for the Project Review Board page: derive and return the dynamic,
 * evidence-based review board for a review feature, run the AI reviewer to
 * enrich it with per-perspective findings, and talk to the review agent. The
 * board is computed on demand from the feature's existing PR review, so a
 * missing review surfaces as the same not-found error the PR review page uses.
 */
export function createReviewBoardRoutes(
  deps: ReviewBoardControllerDeps,
): Route[] {
  return [
    ...(deps.reviewBoard.loadContext ? [{
      method: 'post' as const, path: '/features/:featureId/review-board/context',
      handler: async (req: import('./http-contract.js').HttpRequest) => ({
        status: 200, body: await deps.reviewBoard.loadContext!(req.params.featureId, req.signal),
      }),
    }] : []),
    ...(deps.reviewBoard.repositorySkills ? [{
      method: 'get' as const, path: '/features/:featureId/review-board/skills',
      handler: async (req: import('./http-contract.js').HttpRequest) => ({
        status: 200, body: await deps.reviewBoard.repositorySkills!(req.params.featureId, req.signal),
      }),
    }] : []),
    ...(deps.prComments?.publications ? [{
      method: 'get' as const, path: '/features/:featureId/review-board/publications',
      handler: (req: import('./http-contract.js').HttpRequest) => ({
        status: 200, body: deps.prComments!.publications!(req.params.featureId),
      }),
    }] : []),
    ...(deps.prComments?.reconcilePublication ? [{
      method: 'post' as const, path: '/features/:featureId/review-board/publications/reconcile',
      handler: async (req: import('./http-contract.js').HttpRequest) => {
        const key = (req.body as { key?: unknown } | null)?.key;
        if (typeof key !== 'string' || !key.trim() || key.length > 500) throw new ValidationError('A publication key is required.');
        return { status: 200, body: await deps.prComments!.reconcilePublication!(req.params.featureId, key) };
      },
    }] : []),
    ...(deps.reviewBoard.manageFindings ? [{
      method: 'post' as const,
      path: '/features/:featureId/review-board/findings',
      handler: (req: import('./http-contract.js').HttpRequest) => ({
        status: 200, body: deps.reviewBoard.manageFindings!(req.params.featureId, parseFindingAction(req.body)),
      }),
    }] : []),
    ...(deps.reviewBoard.discussion ? [{
      method: 'get' as const,
      path: '/features/:featureId/review-board/discussion',
      handler: async (req: import('./http-contract.js').HttpRequest) => ({
        status: 200, body: await deps.reviewBoard.discussion!(req.params.featureId),
      }),
    }] : []),
    ...(deps.reviewBoard.configure ? [{
      method: 'post' as const,
      path: '/features/:featureId/review-board/options',
      handler: async (req: import('./http-contract.js').HttpRequest) => ({
        status: 200,
        body: await deps.reviewBoard.configure!(req.params.featureId, parseReviewOptions(req.body), req.signal),
      }),
    }] : []),
    ...(deps.reviewBoard.cancel ? [{
      method: 'post' as const,
      path: '/features/:featureId/review-board/cancel',
      handler: (req: import('./http-contract.js').HttpRequest) => {
        deps.reviewBoard.cancel!(req.params.featureId);
        return { status: 200, body: { cancelled: true } };
      },
    }] : []),
    ...(deps.reviewQueue ? [
      {
        method: 'get' as const,
        path: '/review-board/queue',
        handler: () => ({ status: 200, body: deps.reviewQueue!.pending() }),
      },
      {
        method: 'post' as const,
        path: '/features/:featureId/review-board/queue/settle',
        handler: (req: import('./http-contract.js').HttpRequest) => {
          deps.reviewQueue!.settle(req.params.featureId);
          return { status: 200, body: { settled: true } };
        },
      },
    ] : []),
    {
      method: 'get',
      path: '/features/:featureId/review-board',
      handler: (req) => ({
        status: 200,
        body: deps.reviewBoard.get(req.params.featureId),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/review-board/analyze',
      handler: async (req) => ({
        status: 200,
        body: await deps.reviewBoard.analyze(req.params.featureId, req.signal),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/review-board/perspectives/:perspectiveId/analyze',
      handler: async (req) => ({
        status: 200,
        body: await deps.reviewBoard.analyzePerspective(
          req.params.featureId,
          req.params.perspectiveId,
          req.signal,
        ),
      }),
    },
    {
      method: 'post',
      path: '/features/:featureId/review-board/chat',
      handler: async (req) => {
        const { perspectiveId, messages, context } = assertChat(req.body);
        return {
          status: 200,
          body: await deps.reviewBoard.chat(
            req.params.featureId,
            perspectiveId,
            messages,
            context,
            req.signal,
          ),
        };
      },
    },
  ];
}
