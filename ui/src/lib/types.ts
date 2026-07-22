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

export interface FeatureSummary {
  featureId: string;
  content: string;
  createdAt: string;
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
