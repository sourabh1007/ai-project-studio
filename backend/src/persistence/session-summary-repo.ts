import type { DatabaseSync } from 'node:sqlite';
import type { SessionSummary } from '../session-summary/session-summary-contract.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';

interface SessionSummaryRow {
  session_id: string;
  content: string;
  created_at: string;
}

/** SQLite-backed implementation of the SessionSummaryStore port. */
export function createSessionSummaryRepo(
  db: DatabaseSync,
): SessionSummaryStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO session_summaries (session_id, content, created_at)
     VALUES (?, ?, ?)`,
  );
  const selectOne = db.prepare(
    'SELECT * FROM session_summaries WHERE session_id = ?',
  );
  const deleteOne = db.prepare(
    'DELETE FROM session_summaries WHERE session_id = ?',
  );

  return {
    save(summary: SessionSummary) {
      upsert.run(summary.sessionId, summary.content, summary.createdAt);
    },
    load(sessionId: string) {
      const row = selectOne.get(sessionId) as SessionSummaryRow | undefined;
      if (!row) {
        return null;
      }
      return {
        sessionId: row.session_id,
        content: row.content,
        createdAt: row.created_at,
      };
    },
    delete(sessionId: string) {
      deleteOne.run(sessionId);
    },
  };
}
