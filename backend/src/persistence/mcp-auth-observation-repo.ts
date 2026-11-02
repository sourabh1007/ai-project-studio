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
    'SELECT key, state, checked_at, message, interrupted FROM mcp_auth_observations ORDER BY rowid',
  );
  const remove = db.prepare('DELETE FROM mcp_auth_observations WHERE key = ?');
  const insert = db.prepare(
    `INSERT INTO mcp_auth_observations (key, state, checked_at, message, recorded_at, interrupted)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return {
    load() {
      return (selectAll.all() as Array<{ key: string; state: string; checked_at: string | null; message: string; interrupted: number }>).map((row) => ({
        key: row.key,
        state: {
          state: row.state as McpAuthObservation['state'],
          checkedAt: row.checked_at,
          message: row.message,
          ...(row.interrupted === 1 ? { interrupted: true } : {}),
        },
      }));
    },
    put(key, state) {
      remove.run(key);
      insert.run(key, state.state, state.checkedAt, state.message, new Date().toISOString(), state.interrupted ? 1 : 0);
    },
    delete(key) {
      remove.run(key);
    },
  };
}
