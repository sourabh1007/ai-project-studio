import type { DatabaseSync } from 'node:sqlite';
import type {
  SessionFile,
  SessionFilesStore,
  SessionFileTool,
} from '../session-files/session-files-contract.js';

interface SessionFileRow {
  path: string;
  tool: string;
  first_seen_at: string;
}

/** Splits an absolute path into its basename and directory portion. */
function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/[\\/]+$/, '');
  const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSep < 0) {
    return { name: normalized, dir: '' };
  }
  return {
    name: normalized.slice(lastSep + 1),
    dir: normalized.slice(0, lastSep),
  };
}

function mapRow(row: SessionFileRow): SessionFile {
  const { name, dir } = splitPath(row.path);
  return {
    path: row.path,
    name,
    dir,
    tool: row.tool as SessionFileTool,
    firstSeenAt: row.first_seen_at,
  };
}

/** SQLite-backed implementation of the SessionFilesStore port. */
export function createSessionFilesRepo(db: DatabaseSync): SessionFilesStore {
  const selectOne = db.prepare(
    'SELECT tool, first_seen_at FROM session_files WHERE session_id = ? AND path = ?',
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO session_files (session_id, path, tool, first_seen_at)
     VALUES (?, ?, ?, ?)`,
  );
  const selectBySession = db.prepare(
    'SELECT path, tool, first_seen_at FROM session_files WHERE session_id = ? ORDER BY first_seen_at DESC, path',
  );
  const deleteBySessionRow = db.prepare(
    'DELETE FROM session_files WHERE session_id = ?',
  );

  return {
    record(sessionId, path, tool, at) {
      const existing = selectOne.get(sessionId, path) as
        | { tool: string; first_seen_at: string }
        | undefined;
      // First sighting wins its timestamp; a later 'create' upgrades a prior
      // 'edit' (a file may be edited then reported created out of order).
      const firstSeenAt = existing ? existing.first_seen_at : at;
      const resolvedTool: SessionFileTool =
        existing?.tool === 'create' || tool === 'create' ? 'create' : 'edit';
      insert.run(sessionId, path, resolvedTool, firstSeenAt);
    },
    list(sessionId) {
      return (selectBySession.all(sessionId) as unknown as SessionFileRow[]).map(
        mapRow,
      );
    },
    deleteBySession(sessionId) {
      deleteBySessionRow.run(sessionId);
    },
  };
}
