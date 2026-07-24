/** Shared DTO types mirroring the backend API contracts. */

export interface Feature {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  summary: string | null;
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
}

export interface CreateFeatureInput {
  name: string;
  description: string;
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
}

export interface UpdateSkillInput {
  name: string;
  instructions: string;
}

export interface SkillExport {
  schemaVersion: number;
  name: string;
  kind: SkillKind;
  instructions: string;
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
