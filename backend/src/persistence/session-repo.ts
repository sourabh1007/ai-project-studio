import type { DatabaseSync } from 'node:sqlite';
import type { Session, SessionStatus } from '../session/session-contract.js';
import type { SessionKind } from '../provider/provider-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';

interface SessionRow {
  id: string;
  feature_id: string;
  provider: string;
  requested_model: string;
  resolved_model: string | null;
  status: string;
  kind: string;
  prompt: string;
  usage_file_path: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    featureId: row.feature_id,
    provider: row.provider,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    status: row.status as SessionStatus,
    kind: row.kind as SessionKind,
    prompt: row.prompt,
    usageFilePath: row.usage_file_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
  };
}

/** Coerces a possibly-undefined value to a SQLite-bindable string or null. */
function textOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

/** Coerces a possibly-undefined/non-finite value to a bindable integer or null. */
function intOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/** SQLite-backed implementation of the SessionRepo port. */
export function createSessionRepo(db: DatabaseSync): SessionRepo {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO sessions
      (id, feature_id, provider, requested_model, resolved_model, status, kind,
       prompt, usage_file_path, created_at, started_at, ended_at, exit_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const selectByFeature = db.prepare(
    'SELECT * FROM sessions WHERE feature_id = ? ORDER BY created_at, id',
  );
  const selectAll = db.prepare('SELECT * FROM sessions ORDER BY created_at, id');
  const deleteOne = db.prepare('DELETE FROM sessions WHERE id = ?');
  const deleteByFeature = db.prepare('DELETE FROM sessions WHERE feature_id = ?');

  return {
    save(session) {
      upsert.run(
        session.id,
        session.featureId,
        session.provider,
        session.requestedModel,
        textOrNull(session.resolvedModel),
        session.status,
        session.kind,
        session.prompt,
        session.usageFilePath,
        session.createdAt,
        textOrNull(session.startedAt),
        textOrNull(session.endedAt),
        intOrNull(session.exitCode),
      );
    },
    get(id) {
      const row = selectOne.get(id) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },
    listByFeature(featureId) {
      return (selectByFeature.all(featureId) as unknown as SessionRow[]).map(mapSession);
    },
    listAll() {
      return (selectAll.all() as unknown as SessionRow[]).map(mapSession);
    },
    delete(id) {
      deleteOne.run(id);
    },
    deleteByFeature(featureId) {
      deleteByFeature.run(featureId);
    },
  };
}
