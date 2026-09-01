/** Shared DTO types mirroring the backend API contracts. */

/** Whether the bundled Microsoft `agency` CLI is installed on this machine. */
export interface AgencyStatus {
  installed: boolean;
}

/** Lightweight backend liveness probe payload (`GET /health`). */
export interface HealthStatus {
  status: 'ok';
  uptimeMs: number;
}

export interface GithubStatus {
  authenticated: boolean;
  login: string | null;
}

export interface AzureDevOpsStatus {
  authenticated: boolean;
  account: string | null;
  /** Why a sign-in did not complete (surfaced to the user); null otherwise. */
  message?: string | null;
}

/** The one-time device code shown to the user during GitHub device-flow sign-in. */
export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

/** Result of a single device-flow poll. */
export type DevicePollResult =
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'success' }
  | { status: 'error'; message: string };

/** The source-control provider a repository was selected from. */
export type RepoProvider = 'github' | 'azure-devops';

/**
 * A repository the user has chosen to work on — the top-level unit of the
 * workspace. Features belong to a repository and every session runs inside the
 * repository's local checkout.
 */
export interface Repository {
  id: string;
  provider: RepoProvider;
  remoteUrl: string;
  name: string;
  localPath: string;
  defaultBranch: string | null;
  createdAt: string;
}

export type RepositoryContextStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'failed';

export type RepositoryContextStepStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'skipped';

export interface RepositoryContextStep {
  key: string;
  label: string;
  status: RepositoryContextStepStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RepositoryContextFailure {
  code: string;
  message: string;
  failedAt: string;
  retryable: boolean;
  step: string | null;
}

export interface RepositoryContext {
  repositoryId: string;
  status: RepositoryContextStatus;
  content: string | null;
  sourceRevision: string | null;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    generationStartedAt: string | null;
    generatedAt: string | null;
  };
  steps: RepositoryContextStep[];
  failure: RepositoryContextFailure | null;
}

/** Whether a single agent-readiness parameter is satisfied by the repository. */
export type ReadinessStatus = 'pass' | 'fail';

/** A repo-native skill or custom-agent definition discovered on the branch. */
export interface RepoDefinitionEntry {
  name: string;
  description: string;
  author: string;
  path: string;
}

/** One evaluated agent-readiness parameter and how the repository measured up. */
export interface ReadinessCheck {
  key: string;
  label: string;
  requirement: string;
  status: ReadinessStatus;
  detail: string | null;
}

/** Aggregated, on-demand insights for a repository's default branch. */
export interface RepoInsights {
  repositoryId: string;
  branch: string;
  agents: RepoDefinitionEntry[];
  skills: RepoDefinitionEntry[];
  /** Documentation / troubleshooting-guide files discovered on the branch. */
  docs: RepoDefinitionEntry[];
  readiness: ReadinessCheck[];
  /** True when every readiness parameter passes. */
  agentReady: boolean;
  generatedAt: string;
}

/** The full, read-only content of a discovered skill/agent/doc file. */
export interface RepoDefinitionContent {
  path: string;
  branch: string;
  content: string;
}

/** Lifecycle of a single analysis step within a PR review. */
export type PrReviewStepStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** A retryable generation failure surfaced for one step. */
export interface PrReviewFailure {
  message: string;
  failedAt: string;
}

/**
 * Usage attributed to the metasession that produced one analysis step, so the
 * review page can highlight the exact tokens and credits each metasession spent.
 */
export interface MetaUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  nanoAiu: number;
  credits: number;
}

/** Fields shared by every AI analysis step. */
export interface PrReviewStepBase {
  status: PrReviewStepStatus;
  metaSessionId: string | null;
  usage: MetaUsage | null;
  failure: PrReviewFailure | null;
  /** Live, human-readable activity lines streamed from this step's metasession. */
  activity: string[];
  generatedAt: string | null;
}

/** The problem statement distilled from the PR description by a metasession. */
export interface ProblemStatementStep extends PrReviewStepBase {
  content: string | null;
  /** False when the description carried too little to derive a problem. */
  sufficient: boolean;
}

/**
 * A project the PR's changed files belong to — the square box files are grouped
 * into. Resolved deterministically by walking up to the nearest project manifest
 * (C#: the closest `.csproj`); files with no manifest share a "No project" box.
 */
export interface ChangeGraphProject {
  /** Stable id (the manifest's repo-relative path, or `__none__`). */
  id: string;
  /** Human-readable name shown on the box (manifest file name, sans extension). */
  name: string;
  /** Repo-relative path of the manifest file, or null for the synthetic box. */
  path: string | null;
}

/** How a file was changed by the PR. Drives node colour coding. */
export type PrChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** Whether a changed file is production code or a test. */
export type ChangeGraphCategory = 'code' | 'test';

/** Whether a node is a changed file (orange) or a boundary caller (blue). */
export type ChangeGraphNodeKind = 'changed' | 'boundary';

/**
 * One file in the reference graph. A node is either a file the PR changed
 * (`kind: 'changed'`, orange) or the nearest unchanged caller of a changed file
 * (`kind: 'boundary'`, blue — "who is calling the change").
 */
export interface ChangeGraphNode {
  /** Repository-relative path (the node label and stable id). */
  path: string;
  /** The `id` of the project box this file belongs to. */
  projectId: string;
  /** Finer-grained grouping label (C#: namespace); null when unknown. */
  module: string | null;
  /** Production code vs test — selects which graph the file appears in. */
  category: ChangeGraphCategory;
  /** Whether this is a changed file (orange) or a boundary caller (blue). */
  kind: ChangeGraphNodeKind;
  /** How the PR changed this file; null for boundary callers (unchanged). */
  changeKind: PrChangeKind | null;
  /** The per-file unified diff; empty for boundary callers. */
  diff: string;
  /** What this file does in the codebase, independent of this PR; lazy on click. */
  whatItDoes: string;
  /** What this PR changes in this file; lazy on click. Empty for boundary callers. */
  whatChanged: string;
  /**
   * Syntactic review findings for the change; lazy on click. Each entry is one
   * finding. Empty means no issues were found (or a boundary caller).
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
 * One concrete reference an edge represents: the type in the `to` file that is
 * used, and the calling function/member in the `from` file where it appears.
 */
export interface ChangeGraphEdgeCall {
  symbol: string;
  caller: string | null;
}

/**
 * A directed reference edge `from → to`: the `from` file statically references a
 * type declared by the `to` file. Either both endpoints are changed files, or
 * `from` is a boundary caller of the changed file `to`. Same category.
 */
export interface ChangeGraphEdge {
  /** Repo-relative path of the referencing file. */
  from: string;
  /** Repo-relative path of the declaring file. */
  to: string;
  /** The concrete calls this edge aggregates; absent only on legacy payloads. */
  calls?: ChangeGraphEdgeCall[];
}

/**
 * The change-graph step: a deterministic reference graph of the PR's changed
 * files. Nodes are changed files grouped into project boxes; edges are static
 * type references between changed files. Built with no AI.
 */
export interface ChangeGraphStep extends PrReviewStepBase {
  projects: ChangeGraphProject[];
  nodes: ChangeGraphNode[];
  edges: ChangeGraphEdge[];
}

/** The two analysis steps that make up a review, in execution order. */
export type PrReviewStepKey = 'problemStatement' | 'changeGraph';

/** One turn in the change-graph "explain this diagram" support chat. */
export interface PrReviewChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The assistant's answer to a change-graph chat turn. */
export interface PrReviewChatReply {
  answer: string;
  /** Optional diagram overlay parsed from the answer; absent when none. */
  annotations?: ChangeGraphAnnotations;
}

/** A short note the chat pins to one node to enrich the diagram. */
export interface ChangeGraphAnnotationNote {
  path: string;
  text: string;
}

/** An overlay the "explain this diagram" chat attaches to enhance the diagram. */
export interface ChangeGraphAnnotations {
  /** Node paths to spotlight. */
  highlight: string[];
  /** An ordered path of node paths to trace as a flow. */
  focusFlow: string[];
  /** Short notes pinned to specific nodes. */
  notes: ChangeGraphAnnotationNote[];
}

/** Minimal pull-request identity captured with a review. */
export interface PrReviewPull {
  number: number;
  title: string;
  url: string;
  /** Commit SHA under review (present on the board's pull); null until known. */
  headSha?: string | null;
}

/** A multi-step AI review of a pull request, keyed by its review feature. */
export interface PrReview {
  featureId: string;
  repoId: string;
  pull: PrReviewPull;
  worktreePath: string;
  baseBranch: string | null;
  /** The raw PR description as fetched, before AI distillation; null when none. */
  description: string | null;
  problemStatement: ProblemStatementStep;
  changeGraph: ChangeGraphStep;
  changedFiles: number | null;
  timestamps: {
    createdAt: string;
    updatedAt: string;
  };
}

/** Whether a PR review thread is open (`active`) or resolved. */
export type PrCommentThreadStatus = 'active' | 'resolved';

/* ── Project Review Board ───────────────────────────────────────────────── */

/** How confident a review signal is. Mirrors the backend contract. */
export type ReviewStatus =
  | 'not-started'
  | 'needs-review'
  | 'warning'
  | 'blocked'
  | 'approved'
  | 'not-applicable';

/** Coarse risk band for a perspective or blast-radius dimension. */
export type ReviewRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

/** Severity of a single review finding. */
export type FindingSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'suggestion';

/** Whether a perspective is an always-present core lens or an evidence-derived one. */
export type PerspectiveSource = 'core' | 'detected';

/** One piece of evidence backing a detection, risk marker or finding. */
export interface ReviewEvidence {
  source: string;
  reason: string;
  confidence: number;
  direct: boolean;
}

/** A named thing the discovery engine detected, with its evidence. */
export interface DetectedItem {
  name: string;
  evidence: ReviewEvidence[];
}

/** The evidence-derived understanding of the project a change belongs to. */
export interface ProjectModel {
  projectType: string;
  projectTypeConfidence: number;
  primaryLanguages: string[];
  secondaryLanguages: string[];
  changedComponents: string[];
  changedModules: string[];
  changedRuntimePaths: string[];
  configurationSystems: DetectedItem[];
  testSignals: DetectedItem[];
  deploymentModel: string;
  contracts: DetectedItem[];
  blastRadiusDimensions: string[];
  confidence: number;
  evidence: ReviewEvidence[];
}

/** One concrete, evidence-backed observation under a perspective. */
export interface ReviewFinding {
  id: string;
  perspectiveId: string;
  title: string;
  detail: string;
  severity: FindingSeverity;
  status: ReviewStatus;
  evidence: ReviewEvidence[];
}

/** A rendered review lens with its rolled-up status, risk and findings. */
export interface ReviewPerspective {
  id: string;
  name: string;
  why: string;
  source: PerspectiveSource;
  status: ReviewStatus;
  risk: ReviewRisk;
  findings: ReviewFinding[];
}

/** Header roll-up counts for the board. */
export interface ReviewBoardSummary {
  open: number;
  blocking: number;
  warnings: number;
  suggestions: number;
}

/** The board-level merge recommendation; never auto-approves. */
export type ReviewRecommendation =
  | 'approve'
  | 'request-changes'
  | 'needs-review';

/** The complete Project Review Board for one change. */
export interface ReviewBoard {
  featureId: string;
  pull: PrReviewPull;
  worktreePath: string;
  baseBranch: string | null;
  changedFiles: number;
  model: ProjectModel;
  perspectives: ReviewPerspective[];
  recommendation: ReviewRecommendation;
  summary: ReviewBoardSummary;
  generatedAt: string;
}

/** One turn in the review-agent conversation. */
export interface ReviewBoardChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The analysed state of the focused perspective the reviewer is looking at,
 * handed to the agent so it can reason about the concrete findings/evidence on
 * screen instead of asking which code a question refers to.
 */
export interface ReviewBoardChatContext {
  status: ReviewStatus;
  risk: ReviewRisk;
  findings: ReviewFinding[];
}

/** The review agent's answer to a chat turn. */
export interface ReviewBoardChatReply {
  answer: string;
  /** A rating change the agent was convinced to make, or null. */
  ratingChange: ReviewBoardRatingChange | null;
}

/** A rating adjustment the review agent proposes after being convinced. */
export interface ReviewBoardRatingChange {
  perspectiveId: string;
  status: ReviewStatus;
  risk: ReviewRisk;
  summary: string;
  rationale: RationalePoint[];
  justification: string;
}

/** Outcome of one concrete inspection the reviewer performed for a lens. */
export type CheckStatus = 'pass' | 'concern' | 'na';

/** A single line-item in the reviewer's audit trail. */
export interface PerspectiveCheck {
  item: string;
  finding: string;
  status: CheckStatus;
}

/** A single labeled step in the reviewer's evidence-backed verdict rationale. */
export interface RationalePoint {
  label: string;
  detail: string;
}

/** The AI's verdict for a single perspective: rolled-up result + skip info. */
export interface PerspectiveAnalysis {
  perspectiveId: string;
  perspective: ReviewPerspective;
  skipped: boolean;
  skipReason: string | null;
  /** What the reviewer checked to justify the rating, or null when omitted. */
  summary: string | null;
  /** Evidence-backed labeled narrative justifying the rating. */
  rationale: RationalePoint[];
  /** Line-by-line audit trail of what was inspected and each outcome. */
  checks: PerspectiveCheck[];
}

/**
 * A single live activity line streamed while a perspective is being analysed.
 * `sessionId` identifies the metasession; a new id means a fresh run/attempt,
 * so the client resets the accumulated activity for that perspective.
 */
export interface ReviewBoardActivity {
  featureId: string;
  perspectiveId: string;
  sessionId: string;
  line: string;
}


/** A single comment within a review thread on the pull request. */
export interface PrComment {
  id: string;
  author: string | null;
  body: string;
  createdAt: string | null;
}

/** A review thread on the PR, anchored to a file + line when inline. */
export interface PrCommentThread {
  id: string;
  path: string | null;
  line: number | null;
  status: PrCommentThreadStatus;
  comments: PrComment[];
}

/** Payload posting a new inline comment from the file popup. */
export interface AddPrCommentInput {
  path: string;
  line: number;
  body: string;
}

/** Result returned after approving the pull request from the review page. */
export interface PrApprovalResult {
  approved: true;
  state: 'approved';
  reviewer?: string;
  alreadyApproved?: boolean;
}

export interface PrDescriptionExportResult {
  updated: true;
  url: string;
}

export interface ManagedWorktree {
  path: string;
  branch: string | null;
  repoId: string;
  repoName: string;
  pullNumber: number | null;
}

/** A repository available to pick from a provider before it is added. */
export interface RemoteRepo {
  provider: RepoProvider;
  name: string;
  remoteUrl: string;
  defaultBranch: string | null;
}

/**
 * An open pull request on a repository's provider. The user picks one to
 * review; the backend checks its branch out into a dedicated git worktree and
 * creates a feature whose sessions run there.
 */
export interface RemotePullRequest {
  provider: RepoProvider;
  /** Provider-native PR identifier (GitHub PR number / Azure pullRequestId). */
  number: number;
  title: string;
  url: string;
  /** Head/source branch name. */
  sourceBranch: string;
  /** Author's display name or login, when known. */
  author: string | null;
  /** True when the signed-in user opened this pull request. */
  isAuthor?: boolean;
  /** True when the signed-in user is a requested reviewer. */
  isReviewer?: boolean;
}

/** Server-side scope for listing pull requests. */
export type PullFilter = 'mine' | 'assigned' | 'all';

/** How a picked remote repo becomes a workspace repository. */
export type RepoProvisionMode = 'clone' | 'existing';

export interface AddRepositoryInput {
  provider: RepoProvider;
  remoteUrl: string;
  name: string;
  defaultBranch?: string | null;
  localPath: string;
  mode: RepoProvisionMode;
}

export interface Feature {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  summary: string | null;
  repoId: string | null;
  /** Overrides the session working directory (e.g. a PR review worktree). */
  checkoutPath: string | null;
  /**
   * Parent feature this one nests under in the explorer tree; null for a
   * top-level feature. Set when a PR review is opened from within a feature.
   */
  parentFeatureId?: string | null;
  /** Sort position among sibling features in the same repository group. */
  orderIndex?: number;
}

/** Request to move a feature to a repository group and position (drag-and-drop). */
export interface MoveFeatureInput {
  id: string;
  targetRepoId: string | null;
  targetIndex: number;
}

export type SessionStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SessionKind = 'dev' | 'meta';

export interface Session {
  id: string;
  featureId: string;
  name: string | null;
  provider: string;
  requestedModel: string;
  resolvedModel: string | null;
  status: SessionStatus;
  kind: SessionKind;
  prompt: string;
  /** Fallback work/query title derived from CLI history when prompt is empty. */
  workTitle?: string | null;
  usageFilePath: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  /** Container group this session lives in; null = directly under the feature. */
  groupId?: string | null;
  /** Sort position among its siblings (sessions and groups share the space). */
  orderIndex?: number;
}

/** What a tree group represents: a plain folder or a pull-request container. */
export type TreeGroupKind = 'subcategory' | 'pr';

/** A container node under a feature (subcategory folder or PR). */
export interface TreeGroup {
  id: string;
  featureId: string;
  parentGroupId: string | null;
  kind: TreeGroupKind;
  name: string;
  prNumber: number | null;
  prUrl: string | null;
  orderIndex: number;
  createdAt: string;
}

/** Request to create a new group under a feature (optionally nested). */
export interface CreateGroupInput {
  parentGroupId?: string | null;
  kind: TreeGroupKind;
  name: string;
  prNumber?: number | null;
  prUrl?: string | null;
}

/** The two kinds of movable tree node. */
export type TreeNodeType = 'session' | 'group';

/** Request to move a session or group to a new container and position. */
export interface MoveNodeInput {
  type: TreeNodeType;
  id: string;
  targetFeatureId: string;
  targetParentGroupId: string | null;
  targetIndex: number;
}

/** How a session touched a file, mirrored from the CLI store. */
export type SessionFileTool = 'create' | 'edit';

/** A file a session created or edited, surfaced under the session in the tree. */
export interface SessionFile {
  path: string;
  name: string;
  dir: string;
  tool: SessionFileTool;
  firstSeenAt: string;
}

/** The three layers of the shared-context store, most general to most specific. */
export type ContextScope = 'workspace' | 'repo' | 'feature';

/** How a shared-context document's current content was last produced. */
export type ContextUpdatedBy = 'merge' | 'manual' | 'import';

/**
 * Lifecycle phase of an in-flight shared-context update, streamed live so the UI
 * can animate the otherwise-invisible background merge (generate → save →
 * live-push). `idle` is the terminal frame.
 */
export type ContextStatusPhase = 'generating' | 'saving' | 'sharing' | 'idle';

/** A single live status frame for a scope's context document. */
export interface ContextStatus {
  scope: ContextScope;
  scopeId: string;
  phase: ContextStatusPhase;
}

/** A single curated shared-context document for one scope. */
export interface SharedContextDoc {
  scope: ContextScope;
  scopeId: string;
  content: string;
  updatedAt: string;
  updatedBy: ContextUpdatedBy;
}

export interface UsageTotals {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cost: number;
  credits: number;
  nanoAiu: number;
}

export type UsageOrigin = 'ide' | 'user';

export interface GroupInfo {
  id: string;
  name: string;
  kind: TreeGroupKind;
  parentGroupId: string | null;
}

export interface ModelBreakdown extends UsageTotals {
  model: string;
}

export interface ProviderBreakdown extends UsageTotals {
  provider: string;
}

export interface DailyBreakdown extends UsageTotals {
  day: string;
}

export interface SessionBreakdown extends UsageTotals {
  sessionId: string;
  groupId: string | null;
  origin: UsageOrigin;
  provider: string;
  kind: SessionKind;
  status: SessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Active wall-clock time on this session, in milliseconds. */
  activeMs: number;
}

export interface FeatureTiming {
  totalActiveMs: number;
}

export interface FeatureUsage {
  totals: UsageTotals;
  groups: GroupInfo[];
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
  byDay: DailyBreakdown[];
  bySession: SessionBreakdown[];
  timing: FeatureTiming;
}

export interface WorkspaceStats {
  totals: UsageTotals;
  activeSessions: number;
  totalSessions: number;
}

/** The IDE's own AI (meta-session) usage — assistant overhead, not dev cost. */
export interface IdeUsage {
  totals: UsageTotals;
  byModel: ModelBreakdown[];
  byDay: DailyBreakdown[];
}

export interface FeatureSummary {
  featureId: string;
  content: string;
  createdAt: string;
}

export interface CheckpointSummary {
  number: number;
  title: string;
  overview: string;
  createdAt: string;
}

export interface SessionWorkSummary {
  sessionId: string;
  prompt: string;
  status: SessionStatus;
  createdAt: string;
  summary: string | null;
  checkpoints: CheckpointSummary[];
}

export interface FeatureWorkSummary {
  featureId: string;
  sessions: SessionWorkSummary[];
}

export interface ProviderInfo {
  id: string;
}

export interface ModelInfo {
  id: string;
  label: string;
}

/** One MCP server entry; `spec` round-trips the provider config verbatim. */
export interface McpServerEntry {
  name: string;
  spec: Record<string, unknown>;
  tools?: McpToolEntry[];
  toolDiscovery?: McpToolDiscovery;
}

export interface McpToolEntry {
  name: string;
  description: string | null;
  enabled: boolean;
}

export type McpToolDiscoveryStatus = 'ok' | 'failed' | 'skipped';

export interface McpToolDiscovery {
  status: McpToolDiscoveryStatus;
  message: string | null;
  output: string[];
}

/** MCP configuration currently seen for a provider. */
export interface ProviderMcpConfig {
  providerId: string;
  configPath: string;
  exists: boolean;
  servers: McpServerEntry[];
}

/** Add/update payload for a single MCP server entry (upsert by name). */
export interface McpServerInput {
  name: string;
  spec: Record<string, unknown>;
}

export interface McpApplyResult {
  config: ProviderMcpConfig;
  server: McpServerEntry;
  liveReloadedSessions: number;
  liveReloadCommand: string | null;
}

export interface StoredUsage extends UsageTotals {
  sessionId: string;
  featureId: string;
  turnIndex: number;
  kind: SessionKind;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  operation: string;
  serviceRequestId: string | null;
  startedAt: string;
  endedAt: string;
}

export interface ImportableSession {
  externalId: string;
  provider: string;
  title: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  model: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportSessionInput {
  provider: string;
  externalId: string;
}

export type ConfigValue = unknown;

export interface ConfigResponse {
  namespaces: string[];
  defaults: Record<string, Record<string, ConfigValue>>;
  current: Record<string, Record<string, ConfigValue>>;
  overrides: Record<string, Record<string, ConfigValue>>;
}

/** Result of persisting or resetting one namespace's overrides. */
export interface ConfigUpdateResult {
  namespace: string;
  effective: Record<string, ConfigValue>;
  override: Record<string, ConfigValue>;
  requiresRestart: boolean;
}

/** Live warm-capacity snapshot for one metasession pool. */
export interface MetaPoolStat {
  purpose: string;
  size: number;
  live: number;
  idle: number;
  busy: number;
  ready: boolean;
}

/** Aggregate warm metasession pool status for the Settings page. */
export interface MetaPoolsStatus {
  enabled: boolean;
  pools: MetaPoolStat[];
}

/** Runtime meta AI provider/model powering new metasessions (status bar). */
export interface MetaSettings {
  providerId: string;
  model: string;
  /**
   * True when warm ACP pools are on. Choosing a specific model routes new
   * metasessions to the cold path so the chosen model is honored.
   */
  warmPoolEnabled: boolean;
}

export interface CreateFeatureInput {
  name: string;
  description: string;
  repoId?: string | null;
}

export interface StartSessionInput {
  providerId?: string;
  model?: string;
  prompt: string;
  kind?: SessionKind;
}

export interface StartTerminalSessionInput {
  providerId?: string;
  model?: string;
  kind?: SessionKind;
}

export type SkillKind = 'instruction' | 'task-plan';
export type SkillScope = 'feature' | 'session';
export type SkillRecommendedScope = 'feature' | 'session' | 'any';

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  instructions: string;
  /** Reaction injected when the skill is removed from a live session. */
  removalInstructions: string;
  /** Soft hint about where the skill is most useful (feature/session/any). */
  recommendedScope: SkillRecommendedScope;
  createdAt: string;
}

export interface SkillAttachment {
  id: string;
  skillId: string;
  scope: SkillScope;
  targetId: string;
  createdAt: string;
}

export interface TaggedSkill extends Skill {
  attachmentId: string;
}

export interface CreateSkillInput {
  name: string;
  kind: SkillKind;
  instructions: string;
  removalInstructions?: string;
  recommendedScope?: SkillRecommendedScope;
}

export interface UpdateSkillInput {
  name: string;
  instructions: string;
  removalInstructions?: string;
  recommendedScope?: SkillRecommendedScope;
}

export interface SkillExport {
  schemaVersion: number;
  name: string;
  kind: SkillKind;
  instructions: string;
  removalInstructions: string;
  recommendedScope: SkillRecommendedScope;
}

export type FeatureTaskStatus = 'pending' | 'done';

export interface FeatureTask {
  id: string;
  featureId: string;
  title: string;
  detail: string;
  status: FeatureTaskStatus;
  position: number;
  createdAt: string;
}

export interface AddFeatureTaskInput {
  title: string;
  detail?: string;
}

// --- Monitors & Automations -------------------------------------------------

export type AutomationMode = 'short' | 'long';

export type AutomationStatus =
  | 'active'
  | 'paused'
  | 'needs-auth'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutomationCheckType = 'shell' | 'http' | 'ai' | 'ci-pipeline';

export type AutomationActionType =
  | 'metasession'
  | 'subagent'
  | 'report'
  | 'command';

export interface AutomationOrigin {
  sessionId: string | null;
  featureId: string | null;
}

export interface AutomationPlannedStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'skipped';
  detail: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  endedAt: string | null;
  triggered: boolean;
  status: 'ok' | 'failed' | 'skipped';
  detail: string | null;
  sessionId: string | null;
}

export interface Automation {
  id: string;
  name: string;
  mode: AutomationMode;
  status: AutomationStatus;
  origin: AutomationOrigin;
  check: { type: AutomationCheckType } & Record<string, unknown>;
  condition: { type: string } & Record<string, unknown>;
  action: { type: AutomationActionType } & Record<string, unknown>;
  intervalMs: number;
  maxRuns: number | null;
  runCount: number;
  progress: string | null;
  plannedSteps: AutomationPlannedStep[];
  lastOccurrenceKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  nextRunAt: string | null;
  failure: string | null;
}

export interface Subagent {
  id: string;
  automationId: string | null;
  origin: AutomationOrigin;
  task: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | null;
  result: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationDetail {
  automation: Automation | null;
  runs: AutomationRun[];
  subagents: Subagent[];
}

export interface CreateAutomationInput {
  name: string;
  mode: AutomationMode;
  check: { type: AutomationCheckType } & Record<string, unknown>;
  condition: { type: string } & Record<string, unknown>;
  action: { type: AutomationActionType } & Record<string, unknown>;
  intervalMs?: number;
  maxRuns?: number | null;
  origin?: AutomationOrigin;
}
