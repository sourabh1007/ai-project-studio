import type { DatabaseSync } from 'node:sqlite';
import type { McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';

/**
 * SQLite-backed store for proxy-measured MCP server I/O slices. Rows are
 * append-only (one per reported slice); rollups happen at read time in the
 * aggregate repo via `byMcpServer`.
 */
export function createMcpUsageRepo(db: DatabaseSync): McpUsageRepo {
  const insert = db.prepare(`INSERT INTO mcp_server_usage (
      feature_id, session_id, provider, server, calls,
      input_bytes, output_bytes, duration_ms, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteByFeature = db.prepare(
    'DELETE FROM mcp_server_usage WHERE feature_id = ?',
  );
  const deleteBySession = db.prepare(
    'DELETE FROM mcp_server_usage WHERE session_id = ?',
  );

  return {
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
    },
    deleteBySession(sessionId) {
      deleteBySession.run(sessionId);
    },
  };
}
