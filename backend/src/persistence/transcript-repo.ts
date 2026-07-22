import type { DatabaseSync } from 'node:sqlite';
import type { Transcript } from '../session/transcript-capture.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';

interface TranscriptRow {
  session_id: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

/** SQLite-backed implementation of the TranscriptStore port. */
export function createTranscriptRepo(db: DatabaseSync): TranscriptStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO transcripts (session_id, stdout, stderr, exit_code)
     VALUES (?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM transcripts WHERE session_id = ?');
  const deleteOne = db.prepare('DELETE FROM transcripts WHERE session_id = ?');

  return {
    async save(transcript: Transcript) {
      upsert.run(
        transcript.sessionId,
        JSON.stringify(transcript.stdout),
        JSON.stringify(transcript.stderr),
        transcript.exitCode,
      );
    },
    async load(sessionId: string) {
      const row = selectOne.get(sessionId) as TranscriptRow | undefined;
      if (!row) {
        return null;
      }
      return {
        sessionId: row.session_id,
        stdout: JSON.parse(row.stdout) as string[],
        stderr: JSON.parse(row.stderr) as string[],
        exitCode: row.exit_code,
      };
    },
    async delete(sessionId: string) {
      deleteOne.run(sessionId);
    },
  };
}
