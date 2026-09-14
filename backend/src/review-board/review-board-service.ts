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
import { ProviderError, ValidationError } from '../kernel/error-types.js';
import { MetaAbortError, type MetaRunner } from '../meta/meta-runner.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
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
  ReviewBoardPerspectiveEvent,
  ReviewBoardService,
  ReviewBoardStreamSink,
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
  /**
   * Live count of booted warm metasessions (idle + busy). Sizes how many
   * perspectives {@link ReviewBoardService.analyzeAll} fans out at once: it uses
   * all but one so a session is always reserved for other IDE work. Re-read as
   * the pass proceeds, so capacity added mid-run is picked up. Absent/zero runs
   * one perspective at a time (the safe cold-path default).
   */
  liveMetaSessions?: () => number;
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
      repoId: review.repoId,
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
      reviewUpdatedAt: review.timestamps.updatedAt,
      generatedAt: deps.clock.isoNow(),
    };
  }

  /** Run one AI prompt, delivering it inline or as an attachment. */
  async function runPromptAttempt(
    review: PrReview,
    prompt: string,
    hooks?: PromptHooks,
    signal?: AbortSignal,
    forceCold = false,
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
        toolsOptional: true,
        forceCold,
        label: 'Review board',
        timeoutMs: deps.config.stepTimeoutMs,
        signal,
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
        toolsOptional: true,
        label: 'Review board',
        timeoutMs: deps.config.stepTimeoutMs,
        signal,
        onStart: hooks?.onStart,
        onActivity: hooks?.onActivity,
      });
      return text;
    } finally {
      await temporaryPrompt.cleanup();
    }
  }

  /**
   * Runs a prompt with a durable completion guarantee.
   *
   * Retries used to be limited to failures a classifier recognised as
   * transient, so anything it did not recognise died on the first attempt and
   * reached the user as a bare "Internal server error". Worse, a warm turn that
   * fails after dispatch is deliberately not re-routed cold, so one unhealthy
   * warm session failed every perspective of a board pass identically.
   *
   * Now every failure except a caller abort is retried, and the final attempt
   * is forced onto the cold path so it cannot land on the same broken shared
   * session. What still fails is raised as a {@link ProviderError} carrying the
   * real provider message, so the UI can say what actually went wrong.
   *
   * A *timeout* is the one failure that skips the intermediate warm retries: it
   * already waited out the whole step budget, so retrying it warm just burns
   * another full budget on the same (likely stuck) session. It goes straight to
   * the single forced-cold attempt below — the escape hatch for a broken warm
   * session — instead of amplifying provider load with repeated 120s waits.
   */
  async function runPrompt(
    review: PrReview,
    prompt: string,
    hooks?: PromptHooks,
    signal?: AbortSignal,
  ): Promise<string> {
    let lastError: unknown;
    for (
      let retry = 0;
      retry < deps.config.transientRetryAttempts;
      retry += 1
    ) {
      try {
        return await runPromptAttempt(review, prompt, hooks, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (error instanceof MetaAbortError && error.kind === 'timed_out') {
          break;
        }
        await deps.sleep(deps.config.transientRetryBackoffMs);
      }
    }
    try {
      return await runPromptAttempt(review, prompt, hooks, signal, true);
    } catch (error) {
      if (signal?.aborted) throw error;
      const cause = errorMessage(error) || errorMessage(lastError);
      throw new ProviderError(
        `The review model could not complete this analysis: ${cause}`,
      );
    }
  }

  /**
   * Fan `items` out to `task` with at most `limit()` running at once, re-reading
   * `limit()` each time a slot frees so warm capacity added mid-pass is picked
   * up. Never rejects — `task` owns its own failures; resolves once every item
   * has settled, or immediately once aborted and all in-flight work has drained.
   */
  async function runReserved<T>(
    items: readonly T[],
    limit: () => number,
    task: (item: T) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const queue = [...items];
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (signal?.aborted) {
          if (active === 0) resolve();
          return;
        }
        while (active < Math.max(1, limit()) && queue.length > 0) {
          const item = queue.shift() as T;
          active += 1;
          void task(item).finally(() => {
            active -= 1;
            pump();
          });
        }
        if (active === 0 && queue.length === 0) {
          resolve();
        }
      };
      pump();
    });
  }

  /** How many perspectives to review at once: all live warm sessions but one. */
  function fanOutWidth(): number {
    const live = deps.liveMetaSessions?.() ?? 0;
    return live > 1 ? live - 1 : 1;
  }

  const service: ReviewBoardService = {
    get(featureId: string): ReviewBoard {
      return buildEmptyBoard(toBuildInput(deps.reviews.get(featureId)));
    },

    async analyze(featureId: string, signal?: AbortSignal): Promise<ReviewBoard> {
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
      const text = await runPrompt(review, prompt, undefined, signal);
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
      signal?: AbortSignal,
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
            config: {
              maxContextChars: deps.config.maxContextChars,
              template: deps.config.problemSolutionPromptTemplate,
            },
          })
        : buildPerspectivePrompt({
            board,
            perspective,
            description: review.description,
            changedPaths: changedPathsOf(input),
            config: {
              maxContextChars: deps.config.maxContextChars,
              template: deps.config.perspectivePromptTemplate,
            },
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
      }, signal);
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

    async analyzeAll(
      featureId: string,
      sink: ReviewBoardStreamSink,
      signal?: AbortSignal,
    ): Promise<void> {
      // Resolve (and validate) the review up front so a missing PR review
      // surfaces as a thrown error before we start streaming, matching
      // analyzePerspective. The board also gives us the canonical lens ids.
      const perspectiveIds = service
        .get(featureId)
        .perspectives.map((p) => p.id);
      await runReserved(
        perspectiveIds,
        fanOutWidth,
        async (perspectiveId) => {
          if (signal?.aborted) {
            return;
          }
          const event: ReviewBoardPerspectiveEvent = {
            type: 'analyzing',
            perspectiveId,
          };
          sink.emit(event);
          try {
            const analysis = await service.analyzePerspective(
              featureId,
              perspectiveId,
              signal,
            );
            if (signal?.aborted) {
              return;
            }
            sink.emit({ type: 'analyzed', analysis });
          } catch (error) {
            if (signal?.aborted) {
              return;
            }
            sink.emit({
              type: 'failed',
              perspectiveId,
              error: errorMessage(error),
            });
          }
        },
        signal,
      );
    },

    async chat(
      featureId: string,
      perspectiveId: string | null,
      messages: ReviewBoardChatMessage[],
      context?: ReviewBoardChatContext | null,
      signal?: AbortSignal,
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
      const text = await runPrompt(review, prompt, undefined, signal);
      return parseChatReply(text, perspective?.id ?? null);
    },
  };

  return service;
}
