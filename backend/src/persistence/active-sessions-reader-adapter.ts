import type { DatabaseSync } from 'node:sqlite';
import type { ActiveSessionRecord } from '../active-sessions/active-sessions-contract.js';

/** Read only current instances, never prompts or per-session history files. */
export function createActiveSessionsReader(db: DatabaseSync): () => ActiveSessionRecord[] {
  const read = db.prepare(`SELECT id, feature_id AS featureId, name, provider,
    requested_model AS requestedModel, status, kind, scope, seq
    FROM sessions WHERE status = 'running' ORDER BY created_at, id`);
  return () => read.all() as unknown as ActiveSessionRecord[];
}
