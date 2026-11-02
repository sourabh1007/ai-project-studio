import type { DatabaseSync } from 'node:sqlite';
import type { ClientOperationRecord, ClientOperationRepo } from '../client-operations/client-operations-contract.js';

interface Row {
  scope: string;
  op_key: string;
  request_hash: string;
  state: 'pending' | 'succeeded';
  status: number | null;
  response_json: string | null;
}

export function createClientOperationRepo(db: DatabaseSync): ClientOperationRepo {
  const get = db.prepare('SELECT * FROM client_operations WHERE scope = ? AND op_key = ?');
  const reserve = db.prepare(`INSERT OR IGNORE INTO client_operations
    (scope, op_key, request_hash, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`);
  const complete = db.prepare(`UPDATE client_operations SET state = 'succeeded', status = ?,
    response_json = ?, updated_at = ? WHERE scope = ? AND op_key = ? AND state = 'pending'`);
  const release = db.prepare("DELETE FROM client_operations WHERE scope = ? AND op_key = ? AND request_hash = ? AND state = 'pending'");
  const count = db.prepare('SELECT COUNT(*) AS total FROM client_operations');
  const prune = db.prepare(`DELETE FROM client_operations WHERE rowid IN (
    SELECT rowid FROM client_operations WHERE state = 'succeeded' AND updated_at < ? LIMIT ?)`);

  return {
    get(scope, key): ClientOperationRecord | undefined {
      const row = get.get(scope, key) as unknown as Row | undefined;
      return row === undefined ? undefined : {
        scope: row.scope, key: row.op_key, requestHash: row.request_hash,
        state: row.state, status: row.status, responseJson: row.response_json,
      };
    },
    reservePending: (scope, key, requestHash, nowMs) =>
      Number(reserve.run(scope, key, requestHash, nowMs, nowMs).changes) === 1,
    complete: (scope, key, status, responseJson, nowMs) =>
      Number(complete.run(status, responseJson, nowMs, scope, key).changes) === 1,
    releasePending(scope, key, requestHash) { release.run(scope, key, requestHash); },
    count: () => Number((count.get() as unknown as { total: number | bigint }).total),
    pruneSucceeded: (cutoffMs, limit) => Number(prune.run(cutoffMs, limit).changes),
  };
}
