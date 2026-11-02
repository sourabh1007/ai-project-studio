import type { SessionUsage, UsageTotals } from '../aggregation/aggregation-contract.js';

/**
 * Explicit reliability of a node's native charge total:
 * `none` no sessions; `empty` sessions exist but none has recorded usage yet;
 * `complete` every charge reported; `partial` some reported, some unavailable
 * (`known*` is a lower bound); `unavailable` no charge reported at all.
 * Token counts are always valid.
 */
export type UsageSummaryState = 'none' | 'empty' | 'complete' | 'partial' | 'unavailable';

/** Rolled-up usage for one feature or group, including every nested descendant once. */
export interface UsageSummaryNode {
  totals: UsageTotals;
  state: UsageSummaryState;
  /** Sessions in the node that have no usage rows yet (not counted as zero charges). */
  sessionsWithoutUsage: number;
}

/** Summary for one feature: its own sessions, groups, child features and retained deleted work. */
export interface FeatureUsageSummary extends UsageSummaryNode {
  featureId: string;
  /** Group id -> rolled-up usage, including nested groups and features nested under the group. */
  groups: Record<string, UsageSummaryNode>;
}

/** Workspace-wide batch summary produced from a fixed number of bounded queries. */
export interface UsageSummary {
  features: Record<string, FeatureUsageSummary>;
  /** Usage whose feature no longer exists in the feature table; null when none. */
  unattributed: UsageSummaryNode | null;
}

export interface UsageSummaryFeatureRow {
  id: string;
  parentFeatureId: string | null;
  parentGroupId: string | null;
}

export interface UsageSummaryGroupRow {
  id: string;
  featureId: string;
  parentGroupId: string | null;
}

export interface UsageSummarySessionRow {
  id: string;
  featureId: string;
  groupId: string | null;
}

/** Per feature+session usage, including retained usage of deleted sessions. */
export interface UsageSummaryUsageRow extends SessionUsage {
  featureId: string;
}

/** Read port: four bounded queries, independent of feature/group count. */
export interface UsageSummaryReader {
  features(): UsageSummaryFeatureRow[];
  groups(): UsageSummaryGroupRow[];
  sessions(): UsageSummarySessionRow[];
  usage(): UsageSummaryUsageRow[];
}

export interface UsageSummaryService {
  summary(): UsageSummary;
}

export type { UsageTotals };
