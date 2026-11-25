import type { DatabaseSync } from 'node:sqlite';
import type { McpObservedUsageRepo, McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';

/**
 * SQLite-backed store for proxy-measured MCP server I/O slices. Rows are
 * append-only (one per reported slice); rollups happen at read time in the
 * aggregate repo via `byMcpServer`.
 */
export function createMcpUsageRepo(db: DatabaseSync): McpUsageRepo & McpObservedUsageRepo {
  const insert = db.prepare(`INSERT INTO mcp_server_usage (
      feature_id, session_id, provider, server, calls,
      input_bytes, output_bytes, duration_ms, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertObserved = db.prepare(`INSERT INTO mcp_observed_calls (
      feature_id, session_id, provider, server, tool, call_id, origin, scope, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, session_id, call_id) DO NOTHING`);
  // Only the first completion that is not earlier than the start stamps a
  // duration; a non-positive gap (clock skew) and replays leave it untouched.
  // ROUND (not truncate) absorbs julianday's sub-millisecond float error.
  const stampDuration = db.prepare(`UPDATE mcp_observed_calls
    SET duration_ms = CAST(ROUND((julianday(?) - julianday(recorded_at)) * 86400000) AS INTEGER)
    WHERE provider = ? AND call_id = ? AND duration_ms IS NULL
      AND julianday(?) >= julianday(recorded_at)`);
  const deleteByFeature = db.prepare(
    'DELETE FROM mcp_server_usage WHERE feature_id = ?',
  );
  const deleteBySession = db.prepare(
    'DELETE FROM mcp_server_usage WHERE session_id = ?',
  );
  const deleteObservedByFeature = db.prepare(
    'DELETE FROM mcp_observed_calls WHERE feature_id = ?',
  );
  const deleteObservedBySession = db.prepare(
    'DELETE FROM mcp_observed_calls WHERE session_id = ?',
  );

  return {
    observedHistory(query) {
      return db.prepare(`SELECT call_id AS callId, tool, recorded_at AS at, duration_ms AS durationMs
        FROM mcp_observed_calls WHERE provider = ? AND server = ? AND scope = ?
          AND recorded_at >= ? AND recorded_at < ? ${query.featureId === undefined ? '' : 'AND feature_id = ?'}
        ORDER BY recorded_at DESC, session_id DESC, call_id DESC LIMIT 501`).all(
        query.provider, query.server, query.scope, query.from, query.to,
        ...(query.featureId === undefined ? [] : [query.featureId]),
      ) as unknown as { callId: string; tool: string; at: string; durationMs: number | null }[];
    },
    recordObserved(entry) {
      insertObserved.run(
        entry.featureId,
        entry.sessionId,
        entry.provider,
        entry.server,
        entry.tool,
        entry.callId,
        entry.origin,
        entry.scope,
        entry.recordedAt,
      );
    },
    recordCompletion(entry) {
      stampDuration.run(
        entry.completedAt,
        entry.provider,
        entry.callId,
        entry.completedAt,
      );
    },
    record(entry) {
      insert.run(
        entry.featureId,
        entry.sessionId,
        entry.provider,
        entry.server,
        entry.calls,
        entry.inputBytes,
        entry.outputBytes,
        entry.durationMs,
        entry.recordedAt,
      );
    },
    deleteByFeature(featureId) {
      deleteByFeature.run(featureId);
      deleteObservedByFeature.run(featureId);
    },
    deleteBySession(sessionId) {
      deleteBySession.run(sessionId);
      deleteObservedBySession.run(sessionId);
    },
  };
}
