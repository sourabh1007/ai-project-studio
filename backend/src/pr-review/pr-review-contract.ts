import type { RemotePullRequest } from '../repo/remote-pr-contract.js';

/** Lifecycle of a single analysis step within a PR review. */
export type PrReviewStepStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** A retryable generation failure surfaced for one step. */
export interface PrReviewFailure {
  message: string;
  failedAt: string;
}

/**
 * Usage attributed to the metasession that produced one analysis step. Captured
 * so the review page, feature dashboard and PR session detail can highlight the
 * exact tokens and credits each metasession spent. Zeroed until the metasession
 * has reported usage telemetry.
 */
export interface MetaUsage {
  /** The metasession that produced (or attempted) this step. */
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  nanoAiu: number;
  credits: number;
}

/** Fields shared by every AI analysis step. */
export interface PrReviewStepBase {
  status: PrReviewStepStatus;
  /** The metasession id backing this step; null before it starts. */
  metaSessionId: string | null;
  /** Usage spent by this step's metasession; null until known. */
  usage: MetaUsage | null;
  failure: PrReviewFailure | null;
  /**
   * Human-readable, live activity lines streamed from this step's metasession
   * (assistant messages, tool calls, diagnostics), so the review page can show
   * what the metasession is actually doing instead of an opaque spinner. Capped
   * to the most recent lines.
   */
  activity: string[];
  /** When the current `ready` content was produced; null until first success. */
  generatedAt: string | null;
}

/**
 * The problem statement distilled *from the PR description* by a metasession.
 * `sufficient` is false when the description carried too little to derive a
 * meaningful problem — the UI then shows that plainly instead of inventing one.
 */
export interface ProblemStatementStep extends PrReviewStepBase {
  content: string | null;
  sufficient: boolean;
}

/** How a file was changed by the PR, derived from `git diff --name-status`. */
export type PrChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * Whether a changed file is production code or a test. Derived deterministically
 * from the path so the change graph can split code changes from test changes.
 */
export type ChangeGraphCategory = 'code' | 'test';

/**
 * A project the PR's changed files belong to — the square box files are grouped
 * into. Resolved deterministically by walking up to the nearest project manifest
 * (C#: the closest `.csproj`). Files with no matching manifest share a synthetic
 * "No project" box.
 */
export interface ChangeGraphProject {
  /** Stable id (the manifest's repo-relative path, or `__none__`). */
  id: string;
  /** Human-readable name shown on the box (manifest file name, sans extension). */
  name: string;
  /** Repo-relative path of the manifest file, or null for the synthetic box. */
  path: string | null;
}

/**
 * Whether a change-graph node is a file the PR changed (`changed`, highlighted
 * orange) or an unchanged caller just outside the diff that references a changed
 * file (`boundary`, highlighted blue — "who is calling the change").
 */
export type ChangeGraphNodeKind = 'changed' | 'boundary';

/**
 * One file in the reference graph. A node is either a file the PR changed
 * (`kind: 'changed'`, orange) or the nearest unchanged caller of a changed file
 * (`kind: 'boundary'`, blue). Boundary nodes are discovered by a bounded scan of
 * the changed files' projects and never go deeper than one reference hop.
 */
export interface ChangeGraphNode {
  /** Repository-relative path (the node label and stable id). */
  path: string;
  /** The `id` of the project box this file belongs to. */
  projectId: string;
  /** Finer-grained grouping label (C#: namespace); null when unknown. */
  module: string | null;
  /** Production code vs test — drives which of the two graphs the file lands in. */
  category: ChangeGraphCategory;
  /** Whether this is a changed file (orange) or a boundary caller (blue). */
  kind: ChangeGraphNodeKind;
  /** How the PR changed this file; null for boundary callers (unchanged). */
  changeKind: PrChangeKind | null;
  /** The per-file unified diff; empty for boundary callers (unchanged). */
  diff: string;
  /** What this file does in the codebase, independent of this PR; lazy on click. */
  whatItDoes: string;
  /** What this PR changes in this file; lazy on click. Empty for boundary callers. */
  whatChanged: string;
  /**
   * Syntactic review findings for the change; lazy on click. Each entry is one
   * concrete finding. An empty list means no issues were found (or a boundary
   * caller, which is never reviewed).
   */
  review: string[];
  /**
   * For test files, a per-test-method explanation of what the PR changed in each
   * touched test; lazy on click. Absent/empty for code files, boundary callers,
   * and legacy payloads produced before per-method explanations existed.
   */
  testMethods?: TestMethodExplanation[];
}

/** A plain-English explanation of what a PR changed in one test method. */
export interface TestMethodExplanation {
  /** The test/method name (matches a segment name from the file's diff). */
  name: string;
  /** What this PR changed in that specific test method. */
  whatChanged: string;
}

/**
 * One concrete reference an edge represents: the type (class) in the `to` file
 * that is used, and the calling function/member in the `from` file where the
 * reference occurs (null when it could not be attributed to a member).
 */
export interface ChangeGraphEdgeCall {
  symbol: string;
  caller: string | null;
}

/**
 * A directed reference edge `from → to`: the `from` file statically references a
 * type declared by the `to` file. Either both endpoints are changed files (an
 * intra-diff edge) or `from` is a boundary caller and `to` is the changed file it
 * calls. Both endpoints always share the same category; cross-category edges are
 * not drawn in v1.
 */
export interface ChangeGraphEdge {
  /** Repo-relative path of the referencing file. */
  from: string;
  /** Repo-relative path of the declaring file. */
  to: string;
  /**
   * The specific calls this edge aggregates — the referenced type(s) and the
   * calling member(s). Deduplicated by (symbol, caller). Always present; may be
   * empty for edges restored from a graph persisted before calls were recorded.
   */
  calls: ChangeGraphEdgeCall[];
}

/**
 * The change-graph step: a deterministic reference graph of the PR's changed
 * files. Built by static analysis (no AI): nodes are changed files grouped into
 * project boxes, edges are type references between changed files.
 */
export interface ChangeGraphStep extends PrReviewStepBase {
  projects: ChangeGraphProject[];
  nodes: ChangeGraphNode[];
  edges: ChangeGraphEdge[];
}

/** The analysis steps that make up a review, in execution order. */
export type PrReviewStepKey = 'problemStatement' | 'changeGraph';

/** One turn in the change-graph "explain this diagram" support chat. */
export interface PrReviewChatMessage {
  /** Who authored the turn: the reviewer (`user`) or the assistant. */
  role: 'user' | 'assistant';
  /** The turn's plain-text content. */
  content: string;
}

/** The assistant's answer to a change-graph chat turn. */
export interface PrReviewChatReply {
  /** The assistant's Markdown answer to the latest question. */
  answer: string;
}

/** Minimal pull-request identity captured with a review so it can be re-run. */
export interface PrReviewPull {
  number: number;
  title: string;
  url: string;
}

/** Transition timestamps for a review. */
export interface PrReviewTimestamps {
  createdAt: string;
  updatedAt: string;
}

/**
 * A multi-step AI review of a pull request, keyed by the review feature it
 * belongs to. Produced by two independent paths: the problem statement distilled
 * from the PR description by a metasession, and a deterministic change graph that
 * groups the PR's changed files into project boxes and links them by static type
 * references.
 */
export interface PrReview {
  /** The PR review feature this artifact belongs to. */
  featureId: string;
  repoId: string;
  pull: PrReviewPull;
  /** The PR's git worktree the review analyses and reruns against. */
  worktreePath: string;
  /** Base branch the diff is computed against; null when unknown. */
  baseBranch: string | null;
  /** The raw PR description as fetched, before AI distillation; null when none. */
  description: string | null;
  problemStatement: ProblemStatementStep;
  changeGraph: ChangeGraphStep;
  /** Number of files the PR changes versus its base; null until known. */
  changedFiles: number | null;
  timestamps: PrReviewTimestamps;
}

/** A single changed file with its status and isolated per-file patch. */
export interface PrDiffEntry {
  /** Repository-relative path of the changed file. */
  path: string;
  /** How the file was changed, from `git diff --name-status`. */
  status: PrChangeKind;
  /** The unified diff for just this file, bounded per file. */
  patch: string;
}

/** A bounded view of a pull request's changes versus its base branch. */
export interface PrDiff {
  /** The concrete base ref the diff was taken against, when resolved. */
  baseRef: string | null;
  /** Number of files changed. */
  changedFiles: number;
  /** Repository-relative paths of the changed files. */
  files: string[];
  /** Per-file status and isolated patch for each changed file. */
  entries: PrDiffEntry[];
  /** `git diff --stat` style summary text. */
  stat: string;
  /** Unified diff text, already bounded by the collector. */
  patch: string;
  /** True when the patch was truncated to fit the character budget. */
  truncated: boolean;
}

/** Input identifying the PR worktree/base to diff. */
export interface PrDiffRequest {
  worktreePath: string;
  baseBranch: string | null;
}

/** Collects a bounded PR diff. Implemented by a thin git adapter. */
export interface PrDiffCollector {
  collect(request: PrDiffRequest): Promise<PrDiff>;
}

/** Read port for a metasession's recorded usage, by session id. */
export interface MetaUsageReader {
  /** The usage a metasession spent, or null when none is recorded yet. */
  usageForSession(sessionId: string): MetaUsage | null;
}

/** Persistence port for PR reviews. */
export interface PrReviewRepo {
  get(featureId: string): PrReview | null;
  /**
   * Every persisted review. Used by the startup reconciler to find reviews left
   * mid-generation by a previous run so they can be failed instead of spinning
   * forever.
   */
  listAll(): PrReview[];
  /**
   * The feature id of an existing review for a given repository + PR number, or
   * null when none exists. Lets the app open the same PR's review idempotently
   * instead of creating a duplicate review feature.
   */
  findFeatureByPull(repoId: string, pullNumber: number): string | null;
  save(review: PrReview): void;
  delete(featureId: string): void;
}

/** Input to start a review when a PR review feature is created. */
export interface StartPrReviewInput {
  featureId: string;
  repoId: string;
  pull: RemotePullRequest;
  worktreePath: string;
  baseBranch: string | null;
}

/** Events published as a review progresses, forwarded to the UI over SSE. */
export type PrReviewEventMap = {
  'pr.review.updated': PrReview;
};
