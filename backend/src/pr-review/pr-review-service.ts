import type { Clock } from '../kernel/clock.js';
import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { PrReviewConfig } from './config.js';
import type {
  PrDiffCollector,
  PrReview,
  PrReviewEventMap,
  PrReviewRepo,
  ReadyRepositoryContext,
  StartPrReviewInput,
} from './pr-review-contract.js';
import { buildPrReviewPrompt } from './pr-review-prompt.js';
import { parsePrReview } from './pr-review-parser.js';

export interface PrReviewServiceDeps {
  reviews: PrReviewRepo;
  diffs: PrDiffCollector;
  context: ReadyRepositoryContext;
  /** The reusable "run an AI prompt, get text back" primitive. */
  ai: Pick<MetaRunner, 'run'>;
  clock: Clock;
  bus: EventBus<PrReviewEventMap>;
  config: PrReviewConfig;
}

/**
 * Generates and tracks the AI review of a pull request. When a PR review
 * feature is created the review is started automatically: an internal session
 * loads the repository context and the PR diff and returns a summary plus a
 * core analysis, which are persisted and streamed to the review panel.
 */
export interface PrReviewService {
  /** The review for a feature, or throws when none exists. */
  get(featureId: string): PrReview;
  /** The review for a feature, or null when none exists. */
  find(featureId: string): PrReview | null;
  /** Begins generation for a newly-created PR review feature. */
  start(input: StartPrReviewInput): PrReview;
  /** Re-runs generation for an existing review. */
  refresh(featureId: string): PrReview;
  /** Deletes a review and suppresses any in-flight generation for it. */
  removeForFeature(featureId: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'PR review failed';
}

export function createPrReviewService(
  deps: PrReviewServiceDeps,
): PrReviewService {
  const inFlight = new Set<string>();
  const removed = new Set<string>();

  const publish = (review: PrReview): PrReview => {
    if (removed.has(review.featureId)) {
      return review;
    }
    deps.reviews.save(review);
    deps.bus.emit('pr.review.updated', review);
    return review;
  };

  const runJob = (review: PrReview): void => {
    inFlight.add(review.featureId);
    void (async () => {
      try {
        const diff = await deps.diffs.collect({
          worktreePath: review.worktreePath,
          baseBranch: review.baseBranch,
        });
        const context = deps.context.readyContent(review.repoId);
        const prompt = buildPrReviewPrompt({
          pull: review.pull,
          baseBranch: review.baseBranch,
          context,
          diff,
          maxContextChars: deps.config.maxContextChars,
        });
        const text = await deps.ai.run({
          featureId: review.featureId,
          prompt,
          cwd: review.worktreePath,
          scope: 'internal',
        });
        if (!text.trim()) {
          throw new Error('PR review returned no content');
        }
        const parsed = parsePrReview(text);
        const generatedAt = deps.clock.isoNow();
        publish({
          ...review,
          status: 'ready',
          summary: parsed.summary,
          coreAnalysis: parsed.coreAnalysis,
          changedFiles: diff.changedFiles,
          timestamps: {
            ...review.timestamps,
            updatedAt: generatedAt,
            generatedAt,
          },
          failure: null,
        });
      } catch (error) {
        const failedAt = deps.clock.isoNow();
        publish({
          ...review,
          status: 'failed',
          timestamps: { ...review.timestamps, updatedAt: failedAt },
          failure: { message: errorMessage(error), failedAt },
        });
      } finally {
        inFlight.delete(review.featureId);
      }
    })();
  };

  return {
    get(featureId) {
      const review = deps.reviews.get(featureId);
      if (!review) {
        throw new NotFoundError(`PR review is not available: ${featureId}`);
      }
      return review;
    },
    find(featureId) {
      return deps.reviews.get(featureId);
    },
    start(input) {
      removed.delete(input.featureId);
      const now = deps.clock.isoNow();
      const existing = deps.reviews.get(input.featureId);
      const review: PrReview = {
        featureId: input.featureId,
        repoId: input.repoId,
        pull: {
          number: input.pull.number,
          title: input.pull.title,
          url: input.pull.url,
        },
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
        status: 'generating',
        summary: null,
        coreAnalysis: null,
        changedFiles: null,
        timestamps: {
          createdAt: existing?.timestamps.createdAt ?? now,
          updatedAt: now,
          generatedAt: null,
        },
        failure: null,
      };
      const current = publish(review);
      runJob(review);
      return current;
    },
    refresh(featureId) {
      const existing = deps.reviews.get(featureId);
      if (!existing) {
        throw new NotFoundError(`PR review is not available: ${featureId}`);
      }
      if (inFlight.has(featureId)) {
        throw new ConflictError(
          `PR review generation is already running: ${featureId}`,
        );
      }
      removed.delete(featureId);
      const now = deps.clock.isoNow();
      const regenerating: PrReview = {
        ...existing,
        status: 'generating',
        failure: null,
        timestamps: { ...existing.timestamps, updatedAt: now },
      };
      const current = publish(regenerating);
      runJob(regenerating);
      return current;
    },
    removeForFeature(featureId) {
      removed.add(featureId);
      deps.reviews.delete(featureId);
    },
  };
}
