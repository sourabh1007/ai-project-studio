/**
 * Contract for the Bug Bash agent.
 *
 * The Bug Bash agent stress-tests a feature: it takes a description of the
 * feature plus the setup/instructions needed to exercise it, generates a list
 * of edge-case test scenarios grounded in the feature description and the
 * repository's actual code, asks the user to review and accept them, then runs
 * the accepted scenarios across a team of parallel tester sub-agents and
 * compiles a final report. Unlike New Task it never edits code or opens a pull
 * request — it only reads the repository to find where things might break and
 * reports what it found. Everything project-specific is derived at run time.
 */

/**
 * The lifecycle of one Bug Bash run.
 *
 * `draft` → inputs captured, nothing run yet.
 * `generating`/`generated` → scenarios are being produced / ready to review.
 * `running` → the accepted scenarios are being executed by the tester team.
 * `reported` → every scenario ran and the final report is ready.
 * `failed` → the last operation failed; `error` explains why and the run can be
 *   retried from its current inputs/scenarios.
 */
export type BugBashStatus =
  | 'draft'
  | 'generating'
  | 'generated'
  | 'running'
  | 'reported'
  | 'failed';

/** The outcome of running a single scenario. */
export type BugBashScenarioStatus = 'pending' | 'pass' | 'fail' | 'blocked';

/** One generated test scenario, with its result filled in after a run. */
export interface BugBashScenario {
  /** Stable id within a run, e.g. `scenario-1`. */
  id: string;
  /** What this scenario is testing (the "Scenario" field). */
  title: string;
  /** The input the tester should feed in. */
  input: string;
  /** Ordered steps to perform, using the setup information. */
  steps: string[];
  /** The expected output/behaviour. */
  expectedOutput: string;
  /** Anything the user must confirm/provide before this can run. */
  confirmation: string;
  /** The run outcome; `pending` until a tester executes it. */
  status: BugBashScenarioStatus;
  /** The tester's observations after running it, empty before a run. */
  observations: string;
}

/** The user-supplied inputs that seed a run. */
export interface BugBashInputs {
  /** Intro/description of the feature under test. */
  featureInfo: string;
  /** Documentation links, sample-program links, and setup/test instructions. */
  setupInfo: string;
}

/** One Bug Bash run, persisted per agent attachment. */
export interface BugBashRun {
  /** Stable run id (equals the backing agent attachment id). */
  id: string;
  featureId: string;
  featureInfo: string;
  setupInfo: string;
  /** The generated scenarios (with results once run), empty before generating. */
  scenarios: BugBashScenario[];
  /** The compiled markdown report, or null before a run completes. */
  report: string | null;
  status: BugBashStatus;
  /** The last failure message when `status` is `failed`, else null. */
  error: string | null;
  /**
   * The team that ran the most recent generate/run pass, with each agent's
   * final metrics (time, tokens, AIC). Compact snapshots only — live per-agent
   * logs are streamed during the run and not persisted here.
   */
  agents: BugBashAgent[];
  createdAt: string;
  updatedAt: string;
}

/** Persistence port for Bug Bash runs. */
export interface BugBashRunRepo {
  get(id: string): BugBashRun | null;
  create(run: BugBashRun): void;
  update(run: BugBashRun): void;
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
}

/** The repository workspace a run reads, resolved from its feature. */
export interface BugBashWorkspace {
  repoId: string;
  /** The repository's primary local checkout the agents read/exercise. */
  repoLocalPath: string;
}

/**
 * Resolves the repository workspace for a feature. Throws when the feature has
 * no repository (the agent's prerequisite guarantees one at attach time, but a
 * repository can be detached later).
 */
export interface BugBashWorkspaceResolver {
  resolve(featureId: string): BugBashWorkspace;
}

/** One streamed progress line while a generate/run pass executes. */
export interface BugBashActivity {
  runId: string;
  /** Coarse phase the line belongs to, for grouping in the UI. */
  phase: 'generating' | 'running' | 'reporting' | 'done';
  /** One concise, human-readable line of what is happening. */
  line: string;
  /**
   * The team agent this line was produced by, for per-agent live logs. Omitted
   * for orchestration-level lines that don't belong to a single agent.
   */
  agentId?: string;
}

/**
 * The specialization a {@link BugBashAgent} plays. Generation runs a single
 * `analyst`; a run runs a `lead` that splits the scenarios and compiles the
 * report, plus `tester` sub-agents that execute disjoint groups in parallel.
 */
export type BugBashAgentRole = 'analyst' | 'lead' | 'tester';

/** Lifecycle of a single agent's turn. */
export type BugBashAgentStatus = 'pending' | 'running' | 'done' | 'failed';

/** One agent in a Bug Bash run's team, carrying the live metrics the UI shows. */
export interface BugBashAgent {
  /** Stable id within a run, e.g. `lead`, `tester-1`, `analyst`. */
  id: string;
  /** Parent agent id; null for the root (analyst/lead). */
  parentId: string | null;
  role: BugBashAgentRole;
  /** Short human label for the card. */
  title: string;
  /** Scenario ids this tester owns; empty for analyst/lead. */
  scenarioIds: string[];
  status: BugBashAgentStatus;
  /** Epoch-ms when the agent's current turn started, or null before it runs. */
  startedAt: number | null;
  /** Wall-clock milliseconds the agent's turn(s) took, or null until it ends. */
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  credits: number | null;
}

/** Events the Bug Bash agent publishes onto the workspace bus. */
export type BugBashEventMap = {
  'bug-bash.activity': BugBashActivity;
};

/** Sink a streaming generate/run pass writes its progress + result to. */
export interface BugBashRunSink {
  activity(activity: Omit<BugBashActivity, 'runId'>): void;
  /**
   * Publish an agent snapshot: its creation, a status change, or updated
   * metrics. The UI upserts by agent id, so emitting the same id repeatedly is
   * how a running agent's live metrics update.
   */
  agent?(agent: BugBashAgent): void;
  done(run: BugBashRun): void;
  failed(error: string): void;
}

/** Application service backing the Bug Bash agent page. */
export interface BugBashService {
  /** The run for an attachment, or null when none has been created yet. */
  get(attachmentId: string): BugBashRun | null;
  /** Capture/replace the feature + setup info, seeding or resetting the draft. */
  saveInputs(
    attachmentId: string,
    featureId: string,
    inputs: BugBashInputs,
  ): BugBashRun;
  /**
   * Generate the edge-case scenarios grounded in the inputs and repository code.
   * When a `sink` is supplied the activity is streamed to it (and the settled
   * run or failure reported through it instead of throwing).
   */
  generate(
    attachmentId: string,
    signal?: AbortSignal,
    sink?: BugBashRunSink,
  ): Promise<BugBashRun>;
  /**
   * Run the accepted scenarios across the tester team and compile the report,
   * streaming progress to `sink`. Resolves when the pass settles.
   */
  run(
    attachmentId: string,
    sink: BugBashRunSink,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Cancel-and-reset: revert an in-flight (`generating`/`running`) or `failed`
   * run to a clean state so it can be retried. Inputs and any already-generated
   * scenarios are kept (so a cancelled run re-runs without regenerating); the
   * report and any error are cleared. Returns the reset run, or `null` when no
   * run exists. Aborting the underlying metasession is the caller's
   * responsibility (via the run hub) before calling this.
   */
  reset(attachmentId: string): BugBashRun | null;
}
