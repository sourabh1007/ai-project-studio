/**
 * Contract for the New Task agent.
 *
 * The New Task agent helps a user solve a problem in a repository end to end:
 * it captures a problem statement plus context, plans the change and asks the
 * user to review it, then — on approval — implements the change in an isolated
 * git worktree, opens a pull request, and converts the task into a "PR task" by
 * making the feature eligible for the Review Board. Everything project-specific
 * is derived from the repository at run time; nothing here is hardcoded.
 */

import type { RefineChatMessage } from '../refine-chat/refine-chat.js';
import type { ClarifyResult } from './new-task-prompt.js';

/**
 * The lifecycle of one New Task run.
 *
 * `draft` → inputs captured, nothing run yet.
 * `planning`/`planned` → the AI plan is being produced / is ready to review.
 * `implementing` → the accepted plan is being implemented + a PR opened.
 * `pr-created` → the PR is open and the feature is Review-Board-eligible.
 * `failed` → the last operation failed; `error` explains why and the run can
 *   be retried from its current inputs/plan.
 */
export type NewTaskStatus =
  | 'draft'
  | 'planning'
  | 'planned'
  | 'implementing'
  | 'pr-created'
  | 'failed';

/** One New Task run, persisted per agent attachment. */
export interface NewTaskRun {
  /** Stable run id (equals the backing agent attachment id). */
  id: string;
  featureId: string;
  /** The problem the user wants solved. */
  problem: string;
  /** Free-form context the user supplied about the problem. */
  context: string;
  /** The AI-produced implementation plan, or null before planning. */
  plan: string | null;
  status: NewTaskStatus;
  /** The git branch the change is implemented on, or null before planning. */
  branch: string | null;
  /** The opened pull request number, or null before the PR exists. */
  prNumber: number | null;
  /** The opened pull request URL, or null before the PR exists. */
  prUrl: string | null;
  /**
   * The id of the feature that became the Review-Board-eligible "PR task", or
   * null before the PR exists. This is the New Task's own feature (converted in
   * place), so it equals `featureId` once set. Its presence is what makes the
   * Review Board attachable.
   */
  reviewFeatureId: string | null;
  /** The last failure message when `status` is `failed`, else null. */
  error: string | null;
  /**
   * The team that ran the most recent plan/implement pass, with each agent's
   * final metrics (time, tokens, AIC). Compact snapshots only — live per-agent
   * logs are streamed during the run and not persisted here. Empty before any
   * team has run.
   */
  agents: NewTaskAgent[];
  /**
   * The planner's analysis trail — the discrete "steps it took" (streamed
   * reasoning, tool calls, file reads) captured during the planning turn.
   * Persisted so revisiting a planned run still shows how the plan was reached;
   * the UI renders it as the animated analysis timeline. Empty before planning.
   */
  planLog: string[];
  /**
   * A concise, human-readable title for the task, produced by the planner
   * during the planning turn (falling back to the problem's first line). It
   * renames the task's feature so the workspace reflects the work, and is the
   * heading used by the exported plan document. Null before planning.
   */
  title: string | null;
  /**
   * A one-to-two sentence summary of the solution, produced alongside the plan.
   * Used as the pull request's "Solution" so the description stays concise while
   * the full plan lives in a committed `.md` on the branch. Null before planning.
   */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The user-supplied inputs that seed a run. */
export interface NewTaskInputs {
  problem: string;
  context: string;
}

/** Persistence port for New Task runs. */
export interface NewTaskRunRepo {
  get(id: string): NewTaskRun | null;
  create(run: NewTaskRun): void;
  update(run: NewTaskRun): void;
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
}

/** The repository workspace a run operates in, resolved from its feature. */
export interface NewTaskWorkspace {
  repoId: string;
  /** The repository's primary local checkout (has `origin` configured). */
  repoLocalPath: string;
  /** The branch new PRs target, e.g. the repo default branch. */
  baseBranch: string;
}

/**
 * Resolves the repository workspace for a feature. Throws when the feature has
 * no repository (the agent's prerequisite guarantees one at attach time, but a
 * repository can be detached later).
 */
export interface NewTaskWorkspaceResolver {
  resolve(featureId: string): NewTaskWorkspace;
}

/** A checked-out worktree + branch a change is implemented on. */
export interface NewTaskWorktree {
  worktreePath: string;
  branch: string;
}

/** How a single file was affected by the implementation turn. */
export type NewTaskFileChangeType =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed';

/** One file the implementation changed, for the post-run summary. */
export interface NewTaskFileChange {
  /** Repo-relative path (the new path for a rename). */
  path: string;
  changeType: NewTaskFileChangeType;
}

/** A single file's diff against the base branch, plus its full new content. */
export interface NewTaskFileDiff {
  /** Repo-relative path the diff is for. */
  path: string;
  /** Unified diff of the file against the base branch (empty when unchanged). */
  diff: string;
  /** The full current file content on the branch (empty when deleted/binary). */
  content: string;
}

/** The outcome of committing the worktree: whether anything changed + what. */
export interface NewTaskCommit {
  /** False when the implementation turn made no changes. */
  committed: boolean;
  /** The files the change touched (empty when nothing was committed). */
  files: NewTaskFileChange[];
}

/** Git operations the New Task flow needs, isolated from the change worktree. */
export interface NewTaskGitPort {
  /**
   * Provision a fresh worktree on a new branch based on the repo's base branch,
   * so the change is implemented in isolation from the primary checkout.
   */
  prepareWorktree(input: {
    repoLocalPath: string;
    baseBranch: string;
    runId: string;
    /** Human text (the problem statement) the branch name is derived from. */
    name: string;
    /**
     * The branch a previous plan of this run left behind. When present the
     * planner is re-planning: its worktree and branch are removed so a fresh
     * branch is cut for the new plan (a clean slate, never stacked on stale
     * work).
     */
    previousBranch?: string;
  }): Promise<NewTaskWorktree>;
  /** The deterministic worktree path for a run, without touching git. */
  worktreePathFor(repoLocalPath: string, runId: string): string;
  /**
   * Stage and commit everything in the worktree. Returns whether there was
   * anything to commit (false when the implementation turn made no changes),
   * along with the list of files the change touched.
   */
  commitAll(input: {
    worktreePath: string;
    message: string;
  }): Promise<NewTaskCommit>;
  /** Push the branch to `origin`, setting upstream. */
  pushBranch(input: { worktreePath: string; branch: string }): Promise<void>;
  /**
   * List the files the branch already changed relative to its base branch,
   * whether or not they are committed. Lets a re-run recover a branch a prior
   * attempt committed before it failed (e.g. at the pull-request step), instead
   * of reporting "no changes" because the worktree is now clean.
   */
  changedFilesAgainst(input: {
    worktreePath: string;
    baseBranch: string;
  }): Promise<NewTaskFileChange[]>;
  /**
   * Produce a single file's unified diff against the base branch plus its full
   * current content on the branch, for the post-run "view diff / full file"
   * viewer. Reads from the run's worktree, which persists after the PR is opened.
   */
  fileDiff(input: {
    worktreePath: string;
    baseBranch: string;
    path: string;
  }): Promise<NewTaskFileDiff>;
}

/** The opened pull request. */
export interface NewTaskPullRequest {
  number: number;
  url: string;
}

/** Opens a pull request for a pushed branch (provider-dispatched). */
export interface NewTaskPrPort {
  create(input: {
    repoId: string;
    worktreePath: string;
    branch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<NewTaskPullRequest>;
}

/**
 * Makes the New Task's own feature eligible for the Review Board by converting
 * it into a "PR task": the just-opened PR is checked out into the feature's
 * worktree and a review is started on the same feature id, so the attached New
 * Task run (its problem, plan and PR) is preserved. Returns the feature's id.
 * Wired to the PR-feature conversion flow.
 */
export interface NewTaskReviewPort {
  makeEligible(input: {
    repoId: string;
    prNumber: number;
    featureId: string;
  }): Promise<string>;
}

/**
 * Renames the task's own feature once planning has produced a concise title, so
 * the workspace (tab, headings) reflects the actual work instead of the
 * placeholder the feature was created with.
 */
export interface NewTaskFeaturePort {
  rename(featureId: string, name: string): void;
}

/**
 * Writes the exported plan document into the run's worktree so it is committed
 * on the branch alongside the change and is therefore attached to (visible
 * from) the pull request. Thin fs adapter; keeps the service IO-free.
 */
export interface NewTaskPlanDocPort {
  write(input: {
    worktreePath: string;
    /** Repo-relative path to write, e.g. `NEWTASK-PLAN.md`. */
    path: string;
    content: string;
  }): Promise<void>;
}

/** The settled outcome of one plan refine-chat turn. */
export interface NewTaskRefineResult {
  /** The assistant's markdown reply to append to the chat. */
  reply: string;
  /** The run, unchanged by the turn — a proposed edit is NOT applied here. */
  run: NewTaskRun;
  /**
   * The COMPLETE revised plan the turn proposes, awaiting the user's consent, or
   * null when the turn only answered/discussed without proposing a change. The
   * caller shows it for Apply/Discard and calls {@link NewTaskService.applyRefinedPlan}
   * on Apply; nothing is persisted until then.
   */
  proposal: string | null;
}

/** One streamed progress line while a run's plan/implement turn executes. */
export interface NewTaskActivity {
  runId: string;
  /** Coarse phase the line belongs to, for grouping in the UI. */
  phase: 'planning' | 'implementing' | 'creating-pr' | 'done';
  /** One concise, human-readable line of what is happening. */
  line: string;
  /**
   * The team agent this line was produced by, for per-agent live logs. Omitted
   * for orchestration-level lines that don't belong to a single agent.
   */
  agentId?: string;
}

/**
 * The specialization a {@link NewTaskAgent} plays in a run. Planning runs a
 * single `planner`; implementation runs a `manager` (the lead agent) that
 * decomposes and reviews the work, plus `developer` / `tester` sub-agents that
 * implement disjoint slices in parallel.
 */
export type NewTaskAgentRole =
  | 'planner'
  | 'manager'
  | 'developer'
  | 'tester';

/** Lifecycle of a single agent's turn. */
export type NewTaskAgentStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * One agent in a New Task run's team, carrying the live metrics the UI shows.
 *
 * Planning runs a single `planner`; implementation runs a `manager` (the lead
 * agent) that decomposes the plan and reviews the result, plus `developer` /
 * `tester` sub-agents per disjoint slice of files. Agents form a shallow tree:
 * the manager (or planner) is the root and sub-agents hang off it via `parentId`.
 */
export interface NewTaskAgent {
  /** Durable physical-attempt identities for late vendor usage reconciliation. */
  sessionIds?: string[];
  /** Stable id within a run, e.g. `manager`, `sub-1`, `planner`. */
  id: string;
  /** Parent agent id; null for the root (planner/manager). */
  parentId: string | null;
  role: NewTaskAgentRole;
  /** Short human label for the card, e.g. `API routes`. */
  title: string;
  /** Repo-relative files this sub-agent owns; empty for planner/manager. */
  files: string[];
  status: NewTaskAgentStatus;
  /**
   * Epoch-ms when the agent's current turn started, or null before it runs.
   * Lets the UI show a live-ticking elapsed timer while `status` is `running`.
   */
  startedAt: number | null;
  /** Wall-clock milliseconds the agent's turn(s) took, or null until it ends. */
  durationMs: number | null;
  /** Input tokens consumed, or null when the provider reports none. */
  inputTokens: number | null;
  /** Output tokens produced, or null when the provider reports none. */
  outputTokens: number | null;
  /** AI credits (AIC) burned, or null when the provider omits them. */
  credits: number | null;
}

/** Events the New Task agent publishes onto the workspace bus. */
export type NewTaskEventMap = {
  'new-task.activity': NewTaskActivity;
};

/** Sink the streaming implement pass writes its progress + result to. */
export interface NewTaskImplementSink {
  activity(activity: Omit<NewTaskActivity, 'runId'>): void;
  /**
   * Publish an agent snapshot: its creation, a status change, or updated
   * metrics (duration/tokens/credits). The UI upserts by agent id, so emitting
   * the same id repeatedly is how a running agent's live metrics update.
   */
  agent?(agent: NewTaskAgent): void;
  done(run: NewTaskRun, files?: NewTaskFileChange[]): void;
  failed(error: string): void;
}

/** Optional overrides for a planning turn. */
export interface NewTaskPlanOptions {
  /**
   * Branch to cut the change from, overriding the repository default. Blank or
   * omitted uses the repo's default branch.
   */
  baseBranch?: string;
  /**
   * Reviewer feedback on the previous plan to incorporate into the re-plan.
   */
  suggestion?: string;
}

/** Application service backing the New Task agent page. */
export interface NewTaskService {
  /** The run for an attachment, or null when none has been created yet. */
  get(attachmentId: string): NewTaskRun | null;
  /** Capture/replace the problem + context, seeding or resetting the draft. */
  saveInputs(
    attachmentId: string,
    featureId: string,
    inputs: NewTaskInputs,
  ): NewTaskRun;
  /**
   * Help the user sharpen the task BEFORE planning: run a lightweight AI turn
   * over the current (possibly unsaved) problem + context and return a clearer,
   * well-scoped rewrite of the problem statement plus the concrete pieces of
   * information still missing. Reads nothing from the repo and persists nothing
   * — the UI shows the result for the user to Apply/insert. `featureId` scopes
   * the AI run to the feature's workspace. Throws when the problem is blank.
   */
  clarify(
    featureId: string,
    inputs: NewTaskInputs,
    signal?: AbortSignal,
  ): Promise<ClarifyResult>;
  /**
   * Run the AI planner and return the run enriched with its plan. When a `sink`
   * is supplied the planning activity is streamed to it (and the settled run or
   * failure reported through it instead of throwing); `options` can override the
   * base branch and feed reviewer feedback into a re-plan.
   */
  plan(
    attachmentId: string,
    signal?: AbortSignal,
    sink?: NewTaskImplementSink,
    options?: NewTaskPlanOptions,
  ): Promise<NewTaskRun>;
  /**
   * Implement the accepted plan, open a PR, and convert the task into a PR task
   * (Review-Board-eligible), streaming progress to `sink`. Resolves when the
   * pass settles.
   */
  implement(
    attachmentId: string,
    sink: NewTaskImplementSink,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Run one plan refine-chat turn: the user challenges or asks to edit the
   * generated plan in plain language. `history` is the prior conversation and
   * `message` the new user message. Returns the assistant reply plus a proposed
   * revised plan (when the turn asked for a change) awaiting the user's consent —
   * the stored plan is NOT changed here; call {@link applyRefinedPlan} to accept.
   */
  refine(
    attachmentId: string,
    history: RefineChatMessage[],
    message: string,
    signal?: AbortSignal,
  ): Promise<NewTaskRefineResult>;
  /**
   * Apply a plan revision the user accepted from the refine chat: replace the
   * run's plan with `plan` and persist it. This is the consent step for a
   * {@link NewTaskRefineResult.proposal} — `refine` never changes the plan on
   * its own. Throws when the plan is blank, no run exists, or a PR is already
   * open (a shipped task's plan is frozen). Returns the updated run.
   */
  applyRefinedPlan(attachmentId: string, plan: string): NewTaskRun;
  /**
   * Cancel-and-reset: revert an in-flight (`planning`/`implementing`) or
   * `failed` run to a clean `draft` so it can be retried from its inputs. The
   * problem/context and the last branch are kept (so a subsequent plan removes
   * the stale worktree); the plan and any error are cleared. Returns the reset
   * run, `null` when no run exists, or the run unchanged once a PR is open
   * (a shipped task cannot be reset). Aborting the underlying metasession is the
   * caller's responsibility (via the run hub) before calling this.
   */
  reset(attachmentId: string): NewTaskRun | null;
  /**
   * The unified diff + full content of one changed file on the run's branch, for
   * the summary's per-file diff viewer. Throws when no run/branch exists.
   */
  fileDiff(attachmentId: string, path: string): Promise<NewTaskFileDiff>;
}
