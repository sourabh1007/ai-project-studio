import type { DatabaseSync } from 'node:sqlite';
import type { McpAuthObservation, McpAuthObservationStore } from '../mcp/mcp-contract.js';

/**
 * SQLite-backed store for the last-known native MCP auth observation per server
 * fingerprint. Rows survive restarts so Settings can reflect whether a server
 * previously reported it needed sign-in, without re-probing on load. `put`
 * re-inserts (delete + insert) so `load` returns rows in last-write order,
 * mirroring the in-memory Map's insertion-order eviction.
 */
export function createMcpAuthObservationRepo(db: DatabaseSync): McpAuthObservationStore {
  const selectAll = db.prepare(
    'SELECT key, state, checked_at, message FROM mcp_auth_observations ORDER BY rowid',
  );
  const remove = db.prepare('DELETE FROM mcp_auth_observations WHERE key = ?');
  const insert = db.prepare(
    `INSERT INTO mcp_auth_observations (key, state, checked_at, message, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  return {
    load() {
      return (selectAll.all() as Array<{ key: string; state: string; checked_at: string | null; message: string }>).map((row) => ({
        key: row.key,
        state: {
          state: row.state as McpAuthObservation['state'],
          checkedAt: row.checked_at,
          message: row.message,
        },
      }));
    },
    put(key, state) {
      remove.run(key);
      insert.run(key, state.state, state.checkedAt, state.message, new Date().toISOString());
    },
    delete(key) {
      remove.run(key);
    },
  };
}
