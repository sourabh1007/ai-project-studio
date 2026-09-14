import type { DatabaseSync } from 'node:sqlite';

/**
 * Re-homes a session's *stored usage* onto a new feature. Usage tables
 * (`usage_events`, `meta_usage_records`, `meta_operations`) denormalize
 * `feature_id` for fast per-feature rollups, so a drag-and-drop move that only
 * updates the session's placement would leave its credits credited to the old
 * feature. This port keeps the denormalized attribution in sync with moves.
 */
export interface UsageAttributionRepo {
  reassignSessionFeature(sessionId: string, featureId: string): void;
}

export function createUsageAttributionRepo(
  db: DatabaseSync,
): UsageAttributionRepo {
  const reassignEvents = db.prepare(
    'UPDATE usage_events SET feature_id = ? WHERE session_id = ?',
  );
  const reassignMetaUsage = db.prepare(
    'UPDATE meta_usage_records SET feature_id = ? WHERE session_id = ?',
  );
  const reassignMetaOperations = db.prepare(
    `UPDATE meta_operations SET feature_id = ?
     WHERE operation_id IN (
       SELECT operation_id FROM meta_operation_sessions WHERE session_id = ?
     )`,
  );

  return {
    reassignSessionFeature(sessionId, featureId) {
      reassignEvents.run(featureId, sessionId);
      reassignMetaUsage.run(featureId, sessionId);
      reassignMetaOperations.run(featureId, sessionId);
    },
  };
}
