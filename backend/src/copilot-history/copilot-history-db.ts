import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  PromptHistoryUnavailableError,
  type CopilotHistorySource,
  type HistoryCheckpointRow,
  type HistorySessionRow,
  type HistoryUserMessageRow,
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
 * while the CLI keeps writing (the store runs in WAL mode). Summary, checkpoint
 * and usage-event reads degrade to empty results on failure so auxiliary views
 * never break. The primary prompt read (`userMessages`) instead throws
 * {@link PromptHistoryUnavailableError} when an existing store cannot be read,
 * so a lock or schema drift is never reported as an empty history.
 */
export function createCopilotHistoryDb(
  deps: CopilotHistoryDbDeps,
): CopilotHistorySource {
  function query<T>(sql: string, ids: string[], strict = false): T[] {
    if (ids.length === 0 || !existsSync(deps.databasePath)) {
      return [];
    }
    const failed = (cause: unknown): T[] => {
      if (strict) {
        throw new PromptHistoryUnavailableError(
          'The CLI history store could not be read.',
          { cause },
        );
      }
      return [];
    };
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(deps.databasePath, { readOnly: true });
    } catch (error) {
      return failed(error);
    }
    let rows: T[];
    try {
      rows = db.prepare(sql).all(...ids) as T[];
    } catch (error) {
      db.close();
      return failed(error);
    }
    db.close();
    return rows;
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
    userMessages(sessionId) {
      return query<HistoryUserMessageRow>(
        `SELECT turn_index, user_message, assistant_response, timestamp FROM turns
           WHERE session_id = ? AND user_message IS NOT NULL
           ORDER BY turn_index ASC`,
        [sessionId],
        true,
      );
    },
    usageEventTimes(sessionId) {
      return query<{ created_at: string }>(
        `SELECT created_at FROM assistant_usage_events
           WHERE session_id = ? AND created_at IS NOT NULL
           ORDER BY created_at ASC`,
        [sessionId],
      ).map((row) => row.created_at);
    },
    latestActivityTurn(sessionId) {
      const rows = query<{ max_turn: number | null }>(
        `SELECT MAX(turn_index) AS max_turn FROM assistant_usage_events
           WHERE session_id = ? AND turn_index IS NOT NULL`,
        [sessionId],
      );
      const value = rows[0]?.max_turn;
      return typeof value === 'number' ? value : null;
    },
  };
}
