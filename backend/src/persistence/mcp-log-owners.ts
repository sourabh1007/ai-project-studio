import type { DatabaseSync } from 'node:sqlite';
import type { McpLogOwners, McpLogOwnership, McpLogSource } from '../mcp-usage/mcp-log-capture.js';

/**
 * Only app-owned CLI identities are scanned. Warm reused sessions are attributed
 * by non-overlapping operation time windows, never to the latest feature.
 */
export function createMcpLogOwners(db: DatabaseSync): McpLogOwners {
  const list = db.prepare(`
    SELECT provider || ':' || sessionId AS key, provider, sessionId FROM (
      SELECT provider, id AS sessionId FROM sessions WHERE provider IN ('agency', 'copilot')
      UNION
      SELECT provider_id, provider_session_id FROM meta_operations
      WHERE provider_id IN ('agency', 'copilot') AND transport = 'warm-acp'
        AND provider_session_id IS NOT NULL
    ) WHERE provider || ':' || sessionId > ? ORDER BY key LIMIT ?`);
  const session = db.prepare(`
    SELECT feature_id AS featureId, id AS sessionId, scope
    FROM sessions WHERE id = ? AND provider = ?`);
  const warm = db.prepare(`
    SELECT feature_id AS featureId, COALESCE(session_id, provider_session_id) AS sessionId,
      'internal' AS scope FROM meta_operations
    WHERE provider_session_id = ? AND provider_id = ? AND transport = 'warm-acp'
      AND julianday(COALESCE(started_at, created_at)) <= julianday(?)
      AND (finished_at IS NULL OR julianday(finished_at) >= julianday(?))
    LIMIT 2`);
  return {
    list(after, limit) {
      return list.all(after, limit) as unknown as McpLogSource[];
    },
    resolve(source, timestamp) {
      const direct = session.get(source.sessionId, source.provider) as McpLogOwnership | undefined;
      if (direct) return direct;
      const matches = warm.all(source.sessionId, source.provider, timestamp, timestamp) as unknown as McpLogOwnership[];
      return matches.length === 1 ? matches[0] : null;
    },
  };
}
