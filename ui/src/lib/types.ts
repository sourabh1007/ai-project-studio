/** Shared DTO types mirroring the backend API contracts. */

/** Whether the bundled Microsoft `agency` CLI is installed on this machine. */
export interface AgencyStatus {
  installed: boolean;
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
  | { status: 'pending' }
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

export type PrReviewStatus = 'pending' | 'generating' | 'ready' | 'failed';

export interface PrReviewFailure {
  message: string;
  failedAt: string;
}

/** An AI-generated review of a pull request, keyed by its review feature. */
export interface PrReview {
  featureId: string;
  repoId: string;
  pull: {
    number: number;
    title: string;
    url: string;
  };
  worktreePath: string;
  baseBranch: string | null;
  status: PrReviewStatus;
  summary: string | null;
  coreAnalysis: string | null;
  changedFiles: number | null;
  timestamps: {
    createdAt: string;
    updatedAt: string;
    generatedAt: string | null;
  };
  failure: PrReviewFailure | null;
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

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  instructions: string;
  /** Reaction injected when the skill is removed from a live session. */
  removalInstructions: string;
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
}

export interface UpdateSkillInput {
  name: string;
  instructions: string;
  removalInstructions?: string;
}

export interface SkillExport {
  schemaVersion: number;
  name: string;
  kind: SkillKind;
  instructions: string;
  removalInstructions: string;
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
