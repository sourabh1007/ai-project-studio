import type { SessionKind, SessionStatus } from '../session/session-contract.js';
import type { TreeGroupKind } from '../feature-tree/feature-tree-contract.js';

/** Read-side aggregation contracts for usage rollups. */

/** Summed usage metrics over some grouping. */
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

/** Raw per-session usage rollup as read from the usage store. */
export interface SessionUsage extends UsageTotals {
  sessionId: string;
}

/**
 * Per-session breakdown enriched with the session's identity and the wall-clock
 * time spent on it. Produced by the analytics service, which joins usage
 * rollups with the session lifecycle records.
 */
export interface SessionBreakdown extends SessionUsage {
  provider: string;
  kind: SessionKind;
  status: SessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Active wall-clock time on this session, ms (now-based while running). */
  activeMs: number;
  /** Immediate parent group id, or null when the session sits under the feature. */
  groupId: string | null;
  /**
   * Who drove this AI usage: `ide` for headless metasessions the IDE runs on the
   * user's behalf (PR review, summaries, context merges), `user` for interactive
   * sessions the user launched. Derived from the session kind.
   */
  origin: UsageOrigin;
}

/** Who initiated an AI session's usage. */
export type UsageOrigin = 'ide' | 'user';

/** A container group in a feature's tree, for nesting usage under groups. */
export interface GroupInfo {
  id: string;
  name: string;
  kind: TreeGroupKind;
  /** Parent group id, or null when the group sits directly under the feature. */
  parentGroupId: string | null;
}

/** Time-spent rollup for a feature, derived from session lifecycles. */
export interface FeatureTiming {
  /** Sum of every session's active duration, in milliseconds. */
  totalActiveMs: number;
}

/** Authoritative workspace-wide usage + session counts for the status bar. */
export interface WorkspaceStats {
  totals: UsageTotals;
  /** Number of sessions currently in the running state. */
  activeSessions: number;
  /** Total number of sessions across every feature. */
  totalSessions: number;
}

/** Complete analytics payload for a single feature's dashboard. */
export interface FeatureAnalytics {
  totals: UsageTotals;
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
  byDay: DailyBreakdown[];
  bySession: SessionBreakdown[];
  /** Groups in the feature's tree, so sessions can be nested under them. */
  groups: GroupInfo[];
  timing: FeatureTiming;
}

/** Read port exposing usage rollups; implemented by the persistence module. */
export interface AggregateReader {
  featureTotals(featureId: string): UsageTotals;
  byModel(featureId: string): ModelBreakdown[];
  byProvider(featureId: string): ProviderBreakdown[];
  byDay(featureId: string): DailyBreakdown[];
  bySession(featureId: string): SessionUsage[];
  workspaceTotals(): UsageTotals;
}
