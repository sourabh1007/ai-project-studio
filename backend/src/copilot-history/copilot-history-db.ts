import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  CopilotHistorySource,
  HistoryCheckpointRow,
  HistorySessionRow,
} from './copilot-history-contract.js';

export interface CopilotHistoryDbDeps {
  /** Absolute path to the CLI's session-store.db. */
  databasePath: string;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

/**
 * node:sqlite implementation of {@link CopilotHistorySource}. Opens the CLI
 * store read-only for each query so it always sees the latest committed state
 * while the CLI keeps writing (the store runs in WAL mode). Any failure —
 * missing file, lock, schema drift — degrades to empty results rather than
 * throwing, so the feature view never breaks because of the external store.
 */
export function createCopilotHistoryDb(
  deps: CopilotHistoryDbDeps,
): CopilotHistorySource {
  function query<T>(sql: string, ids: string[]): T[] {
    if (ids.length === 0 || !existsSync(deps.databasePath)) {
      return [];
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(deps.databasePath, { readOnly: true });
    } catch {
      return [];
    }
    try {
      const rows = db.prepare(sql).all(...ids) as T[];
      db.close();
      return rows;
    } catch {
      db.close();
      return [];
    }
  }

  return {
    available() {
      return existsSync(deps.databasePath);
    },
    sessionSummaries(sessionIds) {
      return query<HistorySessionRow>(
        `SELECT s.id, s.summary,
                (SELECT t.user_message FROM turns t
                   WHERE t.session_id = s.id
                   ORDER BY t.turn_index ASC LIMIT 1) AS first_user_message
         FROM sessions s WHERE s.id IN (${placeholders(sessionIds.length)})`,
        sessionIds,
      );
    },
    checkpoints(sessionIds) {
      return query<HistoryCheckpointRow>(
        `SELECT session_id, checkpoint_number, title, overview, created_at
         FROM checkpoints WHERE session_id IN (${placeholders(sessionIds.length)})`,
        sessionIds,
      );
    },
  };
}
