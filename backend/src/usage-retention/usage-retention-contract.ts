/** Contracts for usage that must outlive the session/feature it came from. */

/** The reason a session's usage was summarized into the retention ledger. */
export type RetentionReason = 'session-deleted' | 'feature-deleted';

/** Identity + provenance snapshot captured when a session's usage is retained. */
export interface RetainSessionInput {
  sessionId: string;
  /** Owning feature at deletion time; retained so live features keep crediting
   * deleted sub-sessions and global rollups survive whole-feature deletion. */
  featureId: string | null;
  /** Human-readable feature name snapshot for display after the feature is gone. */
  featureName: string | null;
  /** Session kind (e.g. `meta` for IDE work) so origin survives deletion. */
  sessionKind: string;
  /** Session scope snapshot: `feature` (billable) or `internal` (IDE). */
  scope: string;
  reason: RetentionReason;
  /** ISO timestamp the retention happened. */
  retainedAt: string;
}

/**
 * Writes summarized usage that must survive session/feature deletion. Callers
 * invoke {@link summarizeSession} exactly once, immediately BEFORE purging a
 * session's live `usage_events`/`meta_usage_records`, so monthly and yearly
 * totals never drop when history is pruned.
 */
export interface RetainedUsageWriter {
  summarizeSession(input: RetainSessionInput): void;
}
