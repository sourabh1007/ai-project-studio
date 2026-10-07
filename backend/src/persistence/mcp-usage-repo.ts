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
