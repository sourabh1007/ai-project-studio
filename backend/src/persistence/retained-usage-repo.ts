import type { DatabaseSync } from 'node:sqlite';
import type {
  RetainedUsageWriter,
  RetainSessionInput,
} from '../usage-retention/usage-retention-contract.js';

/**
 * SQLite-backed writer for the {@link RetainedUsageWriter} port. Each summarize
 * runs two `INSERT ... SELECT` rollups (live CLI turns and the warm-ACP meta
 * snapshot) grouped by day/provider/model, so a deleted session collapses into
 * a handful of durable buckets instead of vanishing. Deterministic row ids keep
 * an accidental double-summarize (the detail is already gone after the first)
 * from double counting.
 */
export function createRetainedUsageRepo(db: DatabaseSync): RetainedUsageWriter {
  const insertFromEvents = db.prepare(`
    INSERT OR IGNORE INTO retained_usage (
      id, feature_id, feature_name, session_id, session_kind, scope, source,
      reason, provider, resolved_model, day, sessions,
      input_tokens, output_tokens, reasoning_output_tokens, cost, credits,
      nano_aiu, purpose, label, retained_at
    )
    SELECT
      ? || ':cli:' || substr(started_at, 1, 10) || ':' || provider || ':' || resolved_model,
      ?, ?, ?, ?, ?, 'cli', ?, provider, resolved_model, substr(started_at, 1, 10),
      COUNT(DISTINCT session_id),
      SUM(input_tokens), SUM(output_tokens), SUM(reasoning_output_tokens),
      SUM(cost), SUM(credits), SUM(nano_aiu), NULL, NULL, ?
    FROM usage_events
    WHERE session_id = ?
    GROUP BY substr(started_at, 1, 10), provider, resolved_model
  `);

  const insertFromMeta = db.prepare(`
    INSERT OR IGNORE INTO retained_usage (
      id, feature_id, feature_name, session_id, session_kind, scope, source,
      reason, provider, resolved_model, day, sessions,
      input_tokens, output_tokens, reasoning_output_tokens, cost, credits,
      nano_aiu, purpose, label, retained_at
    )
    SELECT
      ? || ':meta:' || substr(captured_at, 1, 10) || ':' || provider_id || ':'
        || COALESCE(resolved_model, requested_model),
      ?, ?, session_id, ?, ?, 'meta', ?,
      provider_id, COALESCE(resolved_model, requested_model), substr(captured_at, 1, 10),
      1,
      COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), 0,
      0, COALESCE(credits, 0), COALESCE(nano_aiu, 0), purpose, label, ?
    FROM meta_usage_records
    WHERE session_id = ?
  `);

  return {
    summarizeSession(input: RetainSessionInput) {
      insertFromEvents.run(
        input.sessionId,
        input.featureId,
        input.featureName,
        input.sessionId,
        input.sessionKind,
        input.scope,
        input.reason,
        input.retainedAt,
        input.sessionId,
      );
      insertFromMeta.run(
        input.sessionId,
        input.featureId,
        input.featureName,
        input.sessionKind,
        input.scope,
        input.reason,
        input.retainedAt,
        input.sessionId,
      );
    },
  };
}
