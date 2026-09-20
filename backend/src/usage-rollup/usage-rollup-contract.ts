import type {
  McpServerBreakdown,
  ModelBreakdown,
  ProviderBreakdown,
  UsageTotals,
} from '../aggregation/aggregation-contract.js';

/** Time bucket size for a consolidated usage rollup. */
export type UsageGranularity = 'day' | 'week' | 'month' | 'year';

/** Which slice of usage a rollup covers. */
export type UsageRollupScope = 'workspace' | 'ide' | 'feature';

/**
 * One normalized day-grained usage bucket, unioned across every source (live
 * CLI turns, warm-ACP meta snapshots, and retained summaries of deleted work).
 * The pure rollup service folds these into the requested granularity.
 */
export interface UsageDayRow extends UsageTotals {
  day: string;
  provider: string;
  model: string;
}

/** A single time bucket in a rollup, with inclusive calendar bounds. */
export interface UsagePeriod extends UsageTotals {
  /** Stable bucket key: `YYYY-MM-DD` | `YYYY-Www` | `YYYY-MM` | `YYYY`. */
  key: string;
  /** Inclusive first calendar day of the bucket (`YYYY-MM-DD`). */
  start: string;
  /** Inclusive last calendar day of the bucket (`YYYY-MM-DD`). */
  end: string;
  /** Human-readable label for the bucket. */
  label: string;
}

/** Consolidated usage over a scope, bucketed by the requested granularity. */
export interface UsageRollup {
  scope: UsageRollupScope;
  granularity: UsageGranularity;
  totals: UsageTotals;
  periods: UsagePeriod[];
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
  /**
   * Real per-MCP-server tool-call I/O (calls/bytes/latency) measured by the
   * launch proxy, scoped to match this rollup: workspace shows billable dev
   * MCP traffic, IDE shows the app's own metasession MCP traffic, feature shows
   * everything attributed to the feature.
   */
  byMcpServer: McpServerBreakdown[];
}

/**
 * Read port yielding day-grained normalized rows per scope. Kept intentionally
 * dumb (no period math) so the fold into week/month/year lives in a pure,
 * fully-testable service.
 */
export interface UsageRollupReader {
  /** Billable developer usage (feature sessions, excluding IDE overhead). */
  workspaceDays(): UsageDayRow[];
  /** The IDE's own metasession/AI overhead, including warm-ACP meta usage. */
  ideDays(): UsageDayRow[];
  /** Everything attributed to a feature, including its retained deleted work. */
  featureDays(featureId: string): UsageDayRow[];
  /** Proxy-measured MCP tool-call I/O for billable dev (non-internal) sessions. */
  workspaceMcpServers(): McpServerBreakdown[];
  /** Proxy-measured MCP tool-call I/O for the IDE's own metasessions. */
  ideMcpServers(): McpServerBreakdown[];
  /** Proxy-measured MCP tool-call I/O attributed to a feature. */
  featureMcpServers(featureId: string): McpServerBreakdown[];
}
