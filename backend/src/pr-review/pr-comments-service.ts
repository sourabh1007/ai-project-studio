import { NotFoundError, ProviderError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import { reviewFingerprint } from '../review-board/review-run.js';
import type { Repository } from '../repo/repo-contract.js';
import type {
  AddPrCommentInput,
  PrCommentThread,
  PrCommentThreadStatus,
  PrCommentsGatewayResolver,
  PrCommentsService,
  PrReactionContent,
  ReactPrCommentInput,
  ReviewPublication,
} from './pr-comments-contract.js';
import { PR_REACTION_CONTENTS } from './pr-comments-contract.js';
import type { PrReview } from './pr-review-contract.js';
import { assertExpectedHeadSha, hasCapturedRightLine, isRepoRelativePath } from './pr-comment-location.js';

export interface PrCommentsServiceDeps {
  /** Resolves the review (repo id + pull) a feature's comments belong to. */
  reviews: { get(featureId: string): PrReview | null; save?(review: PrReview): void };
  /** Resolves the repository (for provider + slug) a review targets. */
  repos: { get(id: string): Repository | null };
  /** Builds the provider gateway bound to a repo + pull. */
  gateways: PrCommentsGatewayResolver;
  currentHead?: (featureId: string) => Promise<string | null>;
  currentRevisions?: (featureId: string) => Promise<import('./pr-approval-contract.js').PrReviewRevisions>;
  clock?: Clock;
  maxPublications?: number;
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

/** Validates a reaction toggle payload from a request body. */
export function assertReactInput(
  threadId: string,
  commentId: string,
  body: unknown,
): ReactPrCommentInput {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw new ValidationError('A non-empty "threadId" is required.');
  }
  if (typeof commentId !== 'string' || commentId.trim().length === 0) {
    throw new ValidationError('A non-empty "commentId" is required.');
  }
  const raw = (body ?? {}) as { content?: unknown; on?: unknown };
  if (
    typeof raw.content !== 'string' ||
    !(PR_REACTION_CONTENTS as string[]).includes(raw.content)
  ) {
    throw new ValidationError(
      `A valid reaction "content" is required; expected one of ${PR_REACTION_CONTENTS.join(', ')}.`,
    );
  }
  if (typeof raw.on !== 'boolean') {
    throw new ValidationError('A boolean "on" flag is required.');
  }
  return {
    threadId,
    commentId,
    content: raw.content as PrReactionContent,
    on: raw.on,
  };
}

/** Validates an inline comment payload from a request body. */
export function assertAddCommentInput(body: unknown): AddPrCommentInput {
  const raw = (body ?? {}) as {
    path?: unknown;
    line?: unknown;
    body?: unknown;
    expectedHeadSha?: unknown;
    expectedRunId?: unknown;
    expectedAssessmentRevision?: unknown;
    publicationKey?: unknown;
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
  }
  if (raw.expectedRunId !== undefined || raw.expectedAssessmentRevision !== undefined) {
    if (typeof raw.expectedRunId !== 'string' || !raw.expectedRunId.trim() ||
        typeof raw.expectedAssessmentRevision !== 'number' ||
        !Number.isInteger(raw.expectedAssessmentRevision) || raw.expectedAssessmentRevision < 0 ||
        raw.expectedHeadSha === undefined) {
      throw new ValidationError('A valid expectedRunId, expectedAssessmentRevision and expectedHeadSha are required together.');
    }
  }
  if (raw.publicationKey !== undefined && (typeof raw.publicationKey !== 'string' || !raw.publicationKey.trim() ||
      raw.publicationKey.length > 500 || raw.expectedRunId === undefined || raw.body.length > 20_000)) {
    throw new ValidationError('A bounded publicationKey and complete run guards are required for durable publication.');
  }
  return {
    body: raw.body,
    ...(hasPath ? { path: raw.path as string, line: raw.line as number } : {}),
    ...(raw.expectedHeadSha !== undefined ? { expectedHeadSha: raw.expectedHeadSha } : {}),
    ...(raw.expectedRunId !== undefined ? {
      expectedRunId: raw.expectedRunId as string,
      expectedAssessmentRevision: raw.expectedAssessmentRevision as number,
    } : {}),
    ...(raw.publicationKey !== undefined ? { publicationKey: raw.publicationKey as string } : {}),
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
  const pending = new Map<string, Promise<PrCommentThread>>();
  function reviewFor(featureId: string): PrReview {
    const review = deps.reviews.get(featureId);
    if (!review) throw new NotFoundError(`No code review for feature ${featureId}`);
    return review;
  }
  function updatePublication(featureId: string, key: string, record: ReviewPublication | null): void {
    const current = reviewFor(featureId);
    const records = (current.reviewPublications ?? []).filter((item) => item.key !== key);
    deps.reviews.save!({ ...current, reviewPublications: record ? [...records, record] : records });
  }
  function marker(featureId: string, key: string): string {
    return `<!-- studio-review:${reviewFingerprint([featureId, key])} -->`;
  }
  function intent(input: AddPrCommentInput): string {
    return reviewFingerprint([input.body, input.path, input.line, input.expectedHeadSha, input.expectedRunId]);
  }
  const gatewayFor = (
    featureId: string,
    guardedInput?: AddPrCommentInput,
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
      if (guardedInput.expectedRunId !== undefined &&
          (review.reviewBoardRun?.id !== guardedInput.expectedRunId ||
           review.reviewBoardRun.revision !== guardedInput.expectedAssessmentRevision)) {
        throw new ValidationError('The review assessment changed. Refresh the Review Board before posting.');
      }
      if (guardedInput.path !== undefined && guardedInput.line !== undefined) {
        const node = review.changeGraph.nodes.find((candidate) =>
          candidate.path === guardedInput.path && candidate.kind === 'changed');
        if (!isRepoRelativePath(guardedInput.path) || !node ||
            node.changeKind === 'deleted' || !hasCapturedRightLine(node.diff, guardedInput.line)) {
          throw new ValidationError('The exact file and RIGHT-side line are not present in the captured diff. Refresh the Review Board before posting.');
        }
      }
    }
    const repo = deps.repos.get(review.repoId);
    if (!repo) {
      throw new NotFoundError(`No repository ${review.repoId}`);
    }
    return deps.gateways.resolve(repo, review.pull);
  };

  async function sendGuarded(featureId: string, input: AddPrCommentInput, dispatched: () => void): Promise<PrCommentThread> {
    gatewayFor(featureId, input);
    if (deps.currentRevisions) {
      const live = await deps.currentRevisions(featureId);
      const context = reviewFor(featureId).reviewBoardRun?.context;
      if (live.headSha !== input.expectedHeadSha ||
          (context?.baseSha && (context.baseSha !== live.baseSha ||
           (context.targetBranch !== undefined && context.targetBranch !== live.targetBranch)))) {
        throw new ValidationError('The remote head or target branch changed. Prepare a fresh review before posting.');
      }
    } else if (deps.currentHead && await deps.currentHead(featureId) !== input.expectedHeadSha) {
      throw new ValidationError('The remote pull request head changed. Refresh the Review Board before posting.');
    }
    const gateway = gatewayFor(featureId, input);
    dispatched();
    return gateway.add(input);
  }

  return {
    publications(featureId) {
      return reviewFor(featureId).reviewPublications ?? [];
    },
    async reconcilePublication(featureId, key) {
      const record = reviewFor(featureId).reviewPublications?.find((item) => item.key === key);
      if (!record) throw new NotFoundError('Unknown publication operation.');
      if (record.status === 'posted') return record;
      if (!deps.reviews.save) throw new ValidationError('Durable publication storage is unavailable.');
      if (pending.has(`${featureId}:${key}`)) throw new ValidationError('Publication is still running. Wait before reconciling.');
      const matches = (await gatewayFor(featureId).list()).filter((thread) =>
        thread.comments.some((comment) => comment.body.includes(marker(featureId, key))));
      const reconciled: ReviewPublication = matches.length === 1
        ? { ...record, status: 'posted', thread: matches[0], error: undefined }
        : { ...record, status: 'uncertain', error: matches.length
          ? 'Multiple matching threads exist. Check the PR before taking another action.'
          : 'No matching publication is visible yet. Check the PR; this operation will not be resent automatically.' };
      updatePublication(featureId, key, reconciled);
      return reconciled;
    },
    async list(featureId) {
      return gatewayFor(featureId).list();
    },
    async add(featureId, input): Promise<PrCommentThread> {
      if (input.expectedHeadSha !== undefined || input.expectedRunId !== undefined || input.expectedAssessmentRevision !== undefined || input.publicationKey !== undefined) {
        const validated = assertAddCommentInput(input);
        if (validated.publicationKey !== undefined) {
          if (!deps.reviews.save || !deps.clock) throw new ValidationError('Durable publication storage is unavailable.');
          gatewayFor(featureId, validated);
          const key = validated.publicationKey;
          const identity = `${featureId}:${key}`;
          const existing = reviewFor(featureId).reviewPublications?.find((item) => item.key === key);
          if (existing && intent(existing.input) !== intent(validated)) throw new ValidationError('Publication key already belongs to different content.');
          if (existing?.status === 'posted' && existing.thread) return existing.thread;
          const active = pending.get(identity);
          if (active) return active;
          if (existing) {
            updatePublication(featureId, key, { ...existing, status: 'uncertain' });
            throw new ProviderError('Publication status is uncertain. Reconcile or check the PR before posting again.');
          }
          if ((reviewFor(featureId).reviewPublications?.length ?? 0) >= (deps.maxPublications ?? 200)) {
            throw new ValidationError('Publication history is full. Review existing operations before posting.');
          }
          const record: ReviewPublication = { key, status: 'pending', input: validated, startedAt: deps.clock.isoNow() };
          updatePublication(featureId, key, record);
          const operation = (async () => {
            let dispatched = false;
            try {
              const thread = await sendGuarded(featureId, { ...validated, body: `${validated.body}\n\n${marker(featureId, key)}` }, () => { dispatched = true; });
              updatePublication(featureId, key, { ...record, status: 'posted', thread });
              return thread;
            } catch (error) {
              updatePublication(featureId, key, dispatched ? { ...record, status: 'uncertain', error: 'The provider did not confirm publication. Check the PR before retrying.' } : null);
              if (!dispatched) throw error;
              throw new ProviderError('Publication status is uncertain. Reconcile or check the PR before posting again.');
            }
          })();
          pending.set(identity, operation);
          try { return await operation; } finally { pending.delete(identity); }
        }
        return sendGuarded(featureId, validated, () => {});
      }
      return gatewayFor(featureId).add(input);
    },
    async setStatus(featureId, threadId, status): Promise<PrCommentThread> {
      if (typeof threadId !== 'string' || threadId.trim().length === 0) {
        throw new ValidationError('A non-empty "threadId" is required.');
      }
      return gatewayFor(featureId).setStatus(threadId, status);
    },
    async react(featureId, input) {
      return gatewayFor(featureId).react(input);
    },
  };
}
