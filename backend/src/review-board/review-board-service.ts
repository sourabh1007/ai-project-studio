/**
 * Application service backing the Project Review Board page.
 *
 * The board is a *derived* view over a change's existing PR review: it reuses
 * the already-computed change graph and diff as evidence, runs the pure,
 * generic discovery engine to build a `ProjectModel`, and assembles the dynamic
 * board (perspectives + deterministic findings). On top of that deterministic
 * base, `analyze` layers evidence-backed AI findings and `chat` powers a
 * context-aware review agent. All heavy lifting lives in the pure
 * `project-discovery`, `review-board-builder`, `review-board-prompt` and
 * `review-board-parser` modules; this service is thin glue that reads the
 * review, drives the AI runner, and injects config/clock.
 */

import type { Clock } from '../kernel/clock.js';
import { ValidationError } from '../kernel/error-types.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import { isTransientProviderFailure } from '../pr-review/transient-failure.js';
import type { TemporaryPromptFileFactory } from '../repository-context/temporary-prompt-file-port.js';
import type { ReviewBoardConfig } from './config.js';
import { discoverProjectModel } from './project-discovery.js';
import {
  assembleBoard,
  buildDeterministicFindings,
  type BuildBoardInput,
} from './review-board-builder.js';
import { buildAgentChatPrompt, buildFindingsPrompt, buildPerspectivePrompt } from './review-board-prompt.js';
import {
  capPerspectiveFindings,
  parseAiFindings,
  parsePerspectiveAnalysis,
} from './review-board-parser.js';
import type {
  DiscoveryInput,
  PerspectiveAnalysis,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewBoardChatReply,
  ReviewBoardService,
} from './review-board-contract.js';

/** The read port over PR reviews the board derives from. */
export interface ReviewBoardReviewsPort {
  /** The review for a feature, throwing when none exists. */
  get(featureId: string): PrReview;
}

/** The instruction paired with the attachment-delivered prompt (cold path). */
const ATTACHED_PROMPT_INSTRUCTION =
  'Follow the instructions in the attached file and reply exactly as it asks.';

/** Dependencies for {@link createReviewBoardService}. */
export interface ReviewBoardServiceDeps {
  reviews: ReviewBoardReviewsPort;
  config: ReviewBoardConfig;
  clock: Clock;
  /** The reusable "run an AI prompt" primitive. */
  ai: Pick<MetaRunner, 'runDetailed'>;
  /** Writes a step's prompt to a short-lived attachment (cold path). */
  temporaryPrompts: TemporaryPromptFileFactory;
  /** Waits `ms` before a transient-failure retry; injected so tests stay fast. */
  sleep: (ms: number) => Promise<void>;
  /** When true the prompt is carried inline over stdio (warm pool). */
  inlinePrompts?: boolean;
}

/** Project the persisted PR review down to the discovery engine's inputs. */
function toDiscoveryInput(review: PrReview): DiscoveryInput {
  return {
    description: review.description,
    changedFiles: review.changedFiles ?? 0,
    projects: review.changeGraph.projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
    })),
    nodes: review.changeGraph.nodes.map((n) => ({
      path: n.path,
      category: n.category,
      kind: n.kind,
      module: n.module,
    })),
  };
}

/** Read the message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createReviewBoardService(
  deps: ReviewBoardServiceDeps,
): ReviewBoardService {
  /** Build the deterministic board input from a review (shared by all paths). */
  function toBuildInput(review: PrReview): BuildBoardInput {
    const discovery = toDiscoveryInput(review);
    const model = discoverProjectModel(discovery);
    return {
      featureId: review.featureId,
      pull: {
        number: review.pull.number,
        title: review.pull.title,
        url: review.pull.url,
      },
      worktreePath: review.worktreePath,
      baseBranch: review.baseBranch,
      description: review.description,
      nodes: discovery.nodes,
      changedFiles: discovery.changedFiles,
      model,
      thresholds: {
        minDescriptionChars: deps.config.minDescriptionChars,
        blastRadiusMediumThreshold: deps.config.blastRadiusMediumThreshold,
        blastRadiusHighThreshold: deps.config.blastRadiusHighThreshold,
      },
      generatedAt: deps.clock.isoNow(),
    };
  }

  /** Run one AI prompt, delivering it inline or as an attachment. */
  async function runPromptAttempt(
    review: PrReview,
    prompt: string,
  ): Promise<string> {
    if (deps.inlinePrompts) {
      const { text } = await deps.ai.runDetailed({
        featureId: review.featureId,
        prompt,
        cwd: review.worktreePath,
        scope: 'internal',
        noTools: true,
        timeoutMs: deps.config.stepTimeoutMs,
      });
      return text;
    }
    const temporaryPrompt = await deps.temporaryPrompts.create(
      prompt,
      review.worktreePath,
    );
    try {
      const { text } = await deps.ai.runDetailed({
        featureId: review.featureId,
        prompt: ATTACHED_PROMPT_INSTRUCTION,
        attachments: [temporaryPrompt.path],
        cwd: review.worktreePath,
        scope: 'internal',
        noTools: true,
        timeoutMs: deps.config.stepTimeoutMs,
      });
      return text;
    } finally {
      await temporaryPrompt.cleanup();
    }
  }

  /** Run a prompt, retrying only *transient* provider failures. */
  async function runPrompt(review: PrReview, prompt: string): Promise<string> {
    for (
      let retry = 0;
      retry < deps.config.transientRetryAttempts;
      retry += 1
    ) {
      try {
        return await runPromptAttempt(review, prompt);
      } catch (error) {
        if (!isTransientProviderFailure(errorMessage(error))) throw error;
        await deps.sleep(deps.config.transientRetryBackoffMs);
      }
    }
    return runPromptAttempt(review, prompt);
  }

  return {
    get(featureId: string): ReviewBoard {
      const input = toBuildInput(deps.reviews.get(featureId));
      return assembleBoard(input, buildDeterministicFindings(input));
    },

    async analyze(featureId: string): Promise<ReviewBoard> {
      const review = deps.reviews.get(featureId);
      const input = toBuildInput(review);
      const deterministic = buildDeterministicFindings(input);
      const board = assembleBoard(input, deterministic);
      const prompt = buildFindingsPrompt({
        board,
        description: review.description,
        config: { maxContextChars: deps.config.maxContextChars },
      });
      const text = await runPrompt(review, prompt);
      const aiFindings = capPerspectiveFindings(
        parseAiFindings(
          text,
          board.perspectives.map((p) => p.id),
        ),
        deps.config.maxFindingsPerPerspective,
      );
      return assembleBoard(
        { ...input, generatedAt: deps.clock.isoNow() },
        [...deterministic, ...aiFindings],
      );
    },

    async analyzePerspective(
      featureId: string,
      perspectiveId: string,
    ): Promise<PerspectiveAnalysis> {
      const review = deps.reviews.get(featureId);
      const input = toBuildInput(review);
      const deterministic = buildDeterministicFindings(input);
      const board = assembleBoard(input, deterministic);
      const perspective = board.perspectives.find((p) => p.id === perspectiveId);
      if (!perspective) {
        throw new ValidationError(`Unknown perspective: ${perspectiveId}`, {
          field: 'perspectiveId',
        });
      }
      const prompt = buildPerspectivePrompt({
        board,
        perspective,
        description: review.description,
        config: { maxContextChars: deps.config.maxContextChars },
      });
      const text = await runPrompt(review, prompt);
      const parsed = parsePerspectiveAnalysis(text, perspectiveId);
      const aiFindings = capPerspectiveFindings(
        parsed.findings,
        deps.config.maxFindingsPerPerspective,
      );
      const rebuilt = assembleBoard(
        { ...input, generatedAt: deps.clock.isoNow() },
        [...deterministic, ...aiFindings],
      );
      const rolledUp = rebuilt.perspectives.find(
        (p) => p.id === perspectiveId,
      ) as (typeof rebuilt.perspectives)[number];
      return {
        perspectiveId,
        perspective: rolledUp,
        skipped: parsed.skipped,
        skipReason: parsed.skipReason,
      };
    },

    async chat(
      featureId: string,
      perspectiveId: string | null,
      messages: ReviewBoardChatMessage[],
    ): Promise<ReviewBoardChatReply> {
      const review = deps.reviews.get(featureId);
      const input = toBuildInput(review);
      const board = assembleBoard(input, buildDeterministicFindings(input));
      const perspective =
        perspectiveId === null
          ? null
          : board.perspectives.find((p) => p.id === perspectiveId) ?? null;
      const prompt = buildAgentChatPrompt({
        board,
        perspective,
        messages,
        config: { maxContextChars: deps.config.maxContextChars },
      });
      const text = await runPrompt(review, prompt);
      return { answer: text.trim() };
    },
  };
}
