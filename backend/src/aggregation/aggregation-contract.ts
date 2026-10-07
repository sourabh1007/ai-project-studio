import type { SessionKind, SessionStatus } from '../session/session-contract.js';
import type { TreeGroupKind } from '../feature-tree/feature-tree-contract.js';
import type { McpOrigin } from '../mcp-usage/mcp-usage-contract.js';

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

/**
 * Per-provider/server rollup of proxy I/O and observed calls. Call counts use
 * the larger source total per feature/session/provider/server, then sum across
 * sessions. Transport metrics come only from the proxy; billing is unavailable
 * unless a source explicitly attributes it to MCP rather than the whole turn.
 */
export interface McpServerBreakdown {
  server: string;
  provider?: string;
  origin?: McpOrigin;
  inputTokens?: number | null;
  outputTokens?: number | null;
  nanoAiu?: number | null;
  credits?: number | null;
  attribution?: 'reported' | 'unavailable' | 'partial';
  /** Observed or proxy-measured tool calls, deduplicated across sources. */
  calls: number;
  /** Bytes written to the server's stdin (requests). */
  inputBytes: number;
  /** Bytes read from the server's stdout (responses/notifications). */
  outputBytes: number;
  /** Summed wall-clock time attributed to the server's tool calls, ms. */
  durationMs: number;
  /** Earliest observed tool-call time (ISO), from named calls; null when none. */
  firstCallAt?: string | null;
  /** Latest observed tool-call time (ISO), from named calls; null when none. */
  lastCallAt?: string | null;
  /**
   * Per-tool breakdown of the server's observed calls, busiest first. Only
   * covers calls whose public tool name was captured (proxy-only servers and
   * pre-upgrade rows contribute none), so the counts can be a subset of `calls`.
   */
  tools?: McpToolBreakdown[];
}

/** One tool's share of a server's observed MCP calls. */
export interface McpToolBreakdown {
  tool: string;
  calls: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
}

/** Raw per-session usage rollup as read from the usage store. */
export interface SessionUsage extends UsageTotals {
  sessionId: string;
}

/**
 * A warm-ACP agent run tagged to a feature. Warm agents reuse a pooled session
 * so they are never persisted as feature `sessions`; their usage is snapshotted
 * into `meta_usage_records`. This metadata lets analytics surface each agent run
 * as a session row (with its human label) even though no session record exists.
 */
export interface WarmAgentSession {
  sessionId: string;
  provider: string;
  /** Human label captured for the run (e.g. "Bug bash · Tester 3"), or null. */
  label: string | null;
  /** Timestamp the run's usage was captured; used for ordering and timing. */
  capturedAt: string;
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
   * Human label for a session that has no persisted record (a warm-ACP agent
   * run). Null for real sessions, whose display name is resolved from the
   * session record instead.
   */
  label?: string | null;
  /**
   * Who drove this AI usage: `ide` for headless metasessions the IDE runs on the
   * user's behalf (PR review, summaries, context merges), `user` for interactive
   * sessions the user launched, `agent` for warm-ACP agent runs (bug-bash
   * testers, task agents). Derived from the session kind / usage source.
   */
  origin: UsageOrigin;
}

/** Who initiated an AI session's usage. */
export type UsageOrigin = 'ide' | 'user' | 'agent';

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
  /** Per-provider/server calls and proxy-measured transport I/O. */
  byMcpServer: McpServerBreakdown[];
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
  /**
   * Warm-ACP agent runs tagged to a feature (from `meta_usage_records`), so
   * analytics can surface agent usage that has no persisted session record.
   */
  warmAgentSessions(featureId: string): WarmAgentSession[];
  /** Per-provider/server observed calls and proxy I/O for a feature. */
  byMcpServer(featureId: string): McpServerBreakdown[];
  workspaceTotals(): UsageTotals;
}
