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
import type { EventBus } from '../kernel/event-bus.js';
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
  buildEmptyBoard,
  type BuildBoardInput,
} from './review-board-builder.js';
import { buildAgentChatPrompt, buildFindingsPrompt, buildPerspectivePrompt, buildProblemSolutionPrompt, buildSolutionDigest, PROBLEM_SOLUTION_PERSPECTIVE_ID, type SolutionNode } from './review-board-prompt.js';
import { buildPerspectiveEvidenceFloor, buildProblemSolutionFloor, buildSolutionSummary, usableProblemStatement } from './review-board-evidence.js';
import {
  capPerspectiveFindings,
  parseAiFindings,
  parseChatReply,
  parsePerspectiveAnalysis,
} from './review-board-parser.js';
import type {
  DiscoveryInput,
  PerspectiveAnalysis,
  ReviewBoard,
  ReviewBoardChatMessage,
  ReviewBoardChatReply,
  ReviewBoardChatContext,
  ReviewBoardEventMap,
  ReviewBoardService,
  ReviewPerspective,
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
  /** Publishes live per-perspective activity so the UI can stream it. */
  bus: Pick<EventBus<ReviewBoardEventMap>, 'emit'>;
  /** Writes a step's prompt to a short-lived attachment (cold path). */
  temporaryPrompts: TemporaryPromptFileFactory;
  /** Waits `ms` before a transient-failure retry; injected so tests stay fast. */
  sleep: (ms: number) => Promise<void>;
  /** When true the prompt is carried inline over stdio (warm pool). */
  inlinePrompts?: boolean;
}

/** Optional live-progress hooks forwarded to the AI runner for a prompt. */
interface PromptHooks {
  /** Invoked with the metasession id the moment the run launches. */
  onStart?: (sessionId: string) => void;
  /** Invoked with each concise activity line the run produces. */
  onActivity?: (line: string) => void;
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

/**
 * The concrete file paths the change touched, so the AI can ground every
 * finding in a specific file/symbol instead of generic advice. Test scaffolding
 * files are included too — they are legitimate review targets.
 */
function changedPathsOf(input: BuildBoardInput): string[] {
  return input.nodes.filter((n) => n.kind === 'changed').map((n) => n.path);
}

/** Map the review's change-graph nodes to the solution-digest input shape. */
function toSolutionNodes(review: PrReview): SolutionNode[] {
  return review.changeGraph.nodes.map((n) => ({
    path: n.path,
    module: n.module,
    category: n.category,
    kind: n.kind,
    changeKind: n.changeKind,
    whatChanged: n.whatChanged,
    whatItDoes: n.whatItDoes,
    diff: n.diff,
  }));
}

/** The general "solution implemented" line for the Problem ↔ Solution floor. */
function solutionSummaryOf(input: BuildBoardInput): string {
  const changed = input.nodes.filter((n) => n.kind === 'changed');
  return buildSolutionSummary({
    changedCount: changed.length,
    codeCount: changed.filter((n) => n.category === 'code').length,
    components: input.model.changedComponents,
  });
}

/**
 * Give an *analysed* perspective a meaningful rating so the board never leaves a
 * reviewed lens looking un-assessed. A lens the AI reviewed and found clean is
 * marked Approved / Low (a positive result, not the "Unrated" a never-run lens
 * shows); a lens the AI skipped is marked Not-applicable. Lenses that carry
 * findings keep their severity-derived roll-up untouched.
 */
function finalizeAnalyzedPerspective(
  perspective: ReviewPerspective,
  skipped: boolean,
): ReviewPerspective {
  if (perspective.findings.length > 0) return perspective;
  if (skipped) {
    return { ...perspective, status: 'not-applicable', risk: 'unknown' };
  }
  return { ...perspective, status: 'approved', risk: 'low' };
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
        headSha: review.headSha,
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
    hooks?: PromptHooks,
  ): Promise<string> {
    const deliverInline =
      deps.inlinePrompts || prompt.length <= deps.config.coldInlineMaxChars;
    if (deliverInline) {
      const { text } = await deps.ai.runDetailed({
        featureId: review.featureId,
        prompt,
        cwd: review.worktreePath,
        scope: 'internal',
        noTools: true,
        label: 'Review board',
        timeoutMs: deps.config.stepTimeoutMs,
        onStart: hooks?.onStart,
        onActivity: hooks?.onActivity,
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
        label: 'Review board',
        timeoutMs: deps.config.stepTimeoutMs,
        onStart: hooks?.onStart,
        onActivity: hooks?.onActivity,
      });
      return text;
    } finally {
      await temporaryPrompt.cleanup();
    }
  }

  /** Run a prompt, retrying only *transient* provider failures. */
  async function runPrompt(
    review: PrReview,
    prompt: string,
    hooks?: PromptHooks,
  ): Promise<string> {
    for (
      let retry = 0;
      retry < deps.config.transientRetryAttempts;
      retry += 1
    ) {
      try {
        return await runPromptAttempt(review, prompt, hooks);
      } catch (error) {
        if (!isTransientProviderFailure(errorMessage(error))) throw error;
        await deps.sleep(deps.config.transientRetryBackoffMs);
      }
    }
    return runPromptAttempt(review, prompt, hooks);
  }

  return {
    get(featureId: string): ReviewBoard {
      return buildEmptyBoard(toBuildInput(deps.reviews.get(featureId)));
    },

    async analyze(featureId: string): Promise<ReviewBoard> {
      const review = deps.reviews.get(featureId);
      const input = toBuildInput(review);
      const deterministic = buildDeterministicFindings(input);
      const board = assembleBoard(input, deterministic);
      const prompt = buildFindingsPrompt({
        board,
        description: review.description,
        changedPaths: changedPathsOf(input),
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
      const usableProblem = usableProblemStatement(
        review.problemStatement.content,
        review.problemStatement.sufficient,
      );
      const prompt = perspectiveId === PROBLEM_SOLUTION_PERSPECTIVE_ID
        ? buildProblemSolutionPrompt({
            board,
            perspective,
            description: review.description,
            problemStatement: usableProblem,
            problemSufficient: usableProblem !== null,
            solutionDigest: buildSolutionDigest({
              title: review.pull.title,
              nodes: toSolutionNodes(review),
              maxChars: Math.min(deps.config.maxContextChars, 10_000),
            }),
            config: { maxContextChars: deps.config.maxContextChars },
          })
        : buildPerspectivePrompt({
            board,
            perspective,
            description: review.description,
            changedPaths: changedPathsOf(input),
            config: { maxContextChars: deps.config.maxContextChars },
          });
      // Stream what the reviewer is doing for this lens in real time. A fresh
      // metasession id (new run or self-healing attempt) lets the client reset
      // the accumulated activity for this perspective.
      let sessionId = '';
      const emit = (line: string): void => {
        deps.bus.emit('review.board.activity', {
          featureId,
          perspectiveId,
          sessionId,
          line,
        });
      };
      const text = await runPrompt(review, prompt, {
        onStart: (id) => {
          sessionId = id;
          emit('Reviewer session started — reading the change evidence…');
        },
        onActivity: (line) => emit(line),
      });
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
      const finalized = finalizeAnalyzedPerspective(rolledUp, parsed.skipped);
      // A skipped lens was judged not applicable, so it carries no
      // investigation floor — return the model's (possibly empty) detail as-is.
      if (parsed.skipped) {
        return {
          perspectiveId,
          perspective: finalized,
          skipped: true,
          skipReason: parsed.skipReason,
          summary: parsed.summary,
          rationale: parsed.rationale,
          checks: parsed.checks,
        };
      }
      // Guarantee investigation detail for every analysed lens. The headless
      // reviewer sometimes returns a verdict without the rich summary/rationale/
      // checks the UI needs; rather than degrade to a generic "nothing to see"
      // message, layer a deterministic, evidence-grounded floor (built from the
      // real changed files, the lens' concern and the verdict) beneath the
      // model's output and fill any field it left empty.
      const floor = perspectiveId === PROBLEM_SOLUTION_PERSPECTIVE_ID
        ? buildProblemSolutionFloor({
            perspective: finalized,
            problemStatement: usableProblem,
            problemSufficient: usableProblem !== null,
            solutionSummary: solutionSummaryOf(input),
          })
        : buildPerspectiveEvidenceFloor({
            perspective: finalized,
            changedPaths: changedPathsOf(input),
            model: input.model,
          });
      return {
        perspectiveId,
        perspective: finalized,
        skipped: false,
        skipReason: parsed.skipReason,
        summary: parsed.summary ?? floor.summary,
        rationale:
          parsed.rationale.length > 0 ? parsed.rationale : floor.rationale,
        checks: parsed.checks.length > 0 ? parsed.checks : floor.checks,
      };
    },

    async chat(
      featureId: string,
      perspectiveId: string | null,
      messages: ReviewBoardChatMessage[],
      context?: ReviewBoardChatContext | null,
    ): Promise<ReviewBoardChatReply> {
      const review = deps.reviews.get(featureId);
      const input = toBuildInput(review);
      const board = assembleBoard(input, buildDeterministicFindings(input));
      const base =
        perspectiveId === null
          ? null
          : board.perspectives.find((p) => p.id === perspectiveId) ?? null;
      // The re-derived board only carries deterministic findings; when the client
      // sends the analysed state it is looking at, prefer it so the agent reasons
      // about the real, evidence-backed findings on screen.
      const perspective =
        base && context
          ? {
              ...base,
              status: context.status,
              risk: context.risk,
              findings: context.findings,
            }
          : base;
      const prompt = buildAgentChatPrompt({
        board,
        perspective,
        messages,
        config: { maxContextChars: deps.config.maxContextChars },
      });
      const text = await runPrompt(review, prompt);
      return parseChatReply(text, perspective?.id ?? null);
    },
  };
}
