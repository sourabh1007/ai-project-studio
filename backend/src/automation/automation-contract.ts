/**
 * Domain model for **Monitors & Automations**.
 *
 * An {@link Automation} is a persisted monitor that periodically runs a
 * {@link CheckSpec}, evaluates the result against a {@link ConditionSpec}, and —
 * when the condition matches — runs an {@link ActionSpec}. A **short** monitor
 * fires once and completes; a **long** monitor keeps polling and re-fires
 * (edge-triggered) until cancelled. Actions may spawn {@link Subagent}s: tracked
 * background AI tasks with their own progress.
 *
 * This file is pure types + small port interfaces so it carries no runtime code;
 * concrete adapters (repos, runners) implement the ports elsewhere.
 */

/** Short-running (fire once) vs long-running (keep polling) monitor. */
export type AutomationMode = 'short' | 'long';

/** Lifecycle state of an automation. */
export type AutomationStatus =
  | 'active'
  | 'paused'
  | 'needs-auth'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** What a monitor's check reads. */
export type CheckType = 'shell' | 'http' | 'ai' | 'ci-pipeline';

/** What a monitor does when its condition matches. */
export type ActionType = 'metasession' | 'subagent' | 'report' | 'command';

/** Where an automation was created from (for context + usage attribution). */
export interface AutomationOrigin {
  sessionId: string | null;
  featureId: string | null;
}

/** Run a shell command; the result exposes exit code + captured output. */
export interface ShellCheckSpec {
  type: 'shell';
  command: string;
  cwd?: string;
}

/** Poll an HTTP endpoint; the result exposes status + body text. */
export interface HttpCheckSpec {
  type: 'http';
  url: string;
  method?: 'GET' | 'POST';
}

/** Ask the AI a yes/no question; the result exposes the verdict + text. */
export interface AiCheckSpec {
  type: 'ai';
  prompt: string;
  cwd?: string;
}

/** Poll a CI pipeline run; the result exposes its status + conclusion. */
export interface CiPipelineCheckSpec {
  type: 'ci-pipeline';
  provider: 'github' | 'azure';
  /** GitHub `owner/repo` slug, or Azure `org/project` identifier. */
  repo: string;
  /** Optional branch/ref filter; defaults to the repo's default branch. */
  ref?: string;
  /** Optional workflow/pipeline id to disambiguate. */
  pipeline?: string;
}

export type CheckSpec =
  | ShellCheckSpec
  | HttpCheckSpec
  | AiCheckSpec
  | CiPipelineCheckSpec;

/** Normalized result of running a check on one tick. */
export interface CheckResult {
  /** Numeric signal (shell/http status, or 0/1 AI verdict) when applicable. */
  code: number | null;
  /** A short status token (e.g. CI `completed`, http `200`). */
  status: string | null;
  /** A conclusion token when the source distinguishes it (CI `success`). */
  conclusion: string | null;
  /** Trimmed textual output for display / JSON-path conditions. */
  text: string;
  /**
   * A stable token identifying *this occurrence* of a matching condition, so a
   * long-running monitor fires only on transitions (edge-triggered) rather than
   * every tick. E.g. a CI run id, or the http body hash.
   */
  occurrenceKey: string | null;
}

/** How a {@link CheckResult} is turned into a trigger decision. */
export type ConditionSpec =
  | { type: 'always' }
  | { type: 'exit-code'; equals: number }
  | { type: 'status-equals'; value: string }
  | { type: 'conclusion-equals'; value: string }
  | { type: 'text-contains'; value: string }
  | { type: 'ai-verdict' };

/** Run a headless AI metasession with a prompt. */
export interface MetasessionActionSpec {
  type: 'metasession';
  prompt: string;
  cwd?: string;
}

/** Spawn a tracked background AI subagent with an assigned task. */
export interface SubagentActionSpec {
  type: 'subagent';
  task: string;
  prompt: string;
  cwd?: string;
}

/** Generate an analysis report (metasession) and keep it on the run record. */
export interface ReportActionSpec {
  type: 'report';
  prompt: string;
  cwd?: string;
}

/** Run a shell command as the action. */
export interface CommandActionSpec {
  type: 'command';
  command: string;
  cwd?: string;
}

export type ActionSpec =
  | MetasessionActionSpec
  | SubagentActionSpec
  | ReportActionSpec
  | CommandActionSpec;

/** One upcoming/finished step in a monitor's plan, shown in the UI timeline. */
export interface PlannedStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  detail: string | null;
}

/** A tracked background AI task spawned by an action or registered via MCP. */
export interface Subagent {
  id: string;
  automationId: string | null;
  origin: AutomationOrigin;
  task: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | null;
  result: string | null;
  /** The metasession id backing this subagent, for usage attribution. */
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One tick's execution record for an automation. */
export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  endedAt: string | null;
  /** Whether the condition matched and the action ran on this tick. */
  triggered: boolean;
  status: 'ok' | 'failed' | 'skipped';
  /** Human-readable summary (check status + action outcome). */
  detail: string | null;
  /** Metasession id when the action produced one (usage attribution). */
  sessionId: string | null;
}

/** A persisted monitor/automation. */
export interface Automation {
  id: string;
  name: string;
  mode: AutomationMode;
  status: AutomationStatus;
  origin: AutomationOrigin;
  check: CheckSpec;
  condition: ConditionSpec;
  action: ActionSpec;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Optional cap on the number of triggers before completing. */
  maxRuns: number | null;
  /** Number of times the action has fired. */
  runCount: number;
  /** Free-form current-progress line. */
  progress: string | null;
  /** Planned/next steps timeline. */
  plannedSteps: PlannedStep[];
  /** Last check occurrence key that triggered (for edge de-dup). */
  lastOccurrenceKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  nextRunAt: string | null;
  /** Failure detail when `status === 'failed'`. */
  failure: string | null;
}

/** Persistence port for {@link Automation} records. */
export interface AutomationRepo {
  create(automation: Automation): void;
  get(id: string): Automation | null;
  list(): Automation[];
  save(automation: Automation): void;
  delete(id: string): void;
  appendRun(run: AutomationRun): void;
  listRuns(automationId: string): AutomationRun[];
}

/** Persistence port for {@link Subagent} records. */
export interface SubagentRepo {
  create(subagent: Subagent): void;
  get(id: string): Subagent | null;
  list(): Subagent[];
  save(subagent: Subagent): void;
  listByAutomation(automationId: string): Subagent[];
}

/** Context handed to a check/action runner for one execution. */
export interface RunContext {
  automationId: string;
  origin: AutomationOrigin;
  /** Aborted when a lifecycle command stops the in-flight tick. */
  signal?: AbortSignal;
}

/** Runs a {@link CheckSpec} and returns a normalized {@link CheckResult}. */
export interface CheckRunner {
  run(spec: CheckSpec, ctx: RunContext): Promise<CheckResult>;
}

/** Outcome of running an action. */
export interface ActionResult {
  detail: string;
  sessionId: string | null;
  subagentId: string | null;
  report: string | null;
}

/** Runs an {@link ActionSpec}. */
export interface ActionRunner {
  run(spec: ActionSpec, ctx: RunContext): Promise<ActionResult>;
}
