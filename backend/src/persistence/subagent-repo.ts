import type { DatabaseSync } from 'node:sqlite';
import type {
  Subagent,
  SubagentRepo,
} from '../automation/automation-contract.js';

interface SubagentRow {
  id: string;
  automation_id: string | null;
  origin_session_id: string | null;
  origin_feature_id: string | null;
  task: string;
  status: string;
  progress: string | null;
  result: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapSubagent(row: SubagentRow): Subagent {
  return {
    id: row.id,
    automationId: row.automation_id,
    origin: {
      sessionId: row.origin_session_id,
      featureId: row.origin_feature_id,
    },
    task: row.task,
    status: row.status as Subagent['status'],
    progress: row.progress,
    result: row.result,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed implementation of the {@link SubagentRepo} port. */
export function createSubagentRepo(db: DatabaseSync): SubagentRepo {
  const insert = db.prepare(
    `INSERT INTO subagents (
      id, automation_id, origin_session_id, origin_feature_id, task,
      status, progress, result, session_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE subagents SET
      automation_id = ?, origin_session_id = ?, origin_feature_id = ?,
      task = ?, status = ?, progress = ?, result = ?, session_id = ?,
      created_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const selectOne = db.prepare('SELECT * FROM subagents WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM subagents ORDER BY created_at, id',
  );
  const selectByAutomation = db.prepare(
    'SELECT * FROM subagents WHERE automation_id = ? ORDER BY created_at, id',
  );

  const writeColumns = (subagent: Subagent): unknown[] => [
    subagent.automationId,
    subagent.origin.sessionId,
    subagent.origin.featureId,
    subagent.task,
    subagent.status,
    subagent.progress,
    subagent.result,
    subagent.sessionId,
    subagent.createdAt,
    subagent.updatedAt,
  ];

  return {
    create(subagent) {
      insert.run(subagent.id, ...(writeColumns(subagent) as never[]));
    },
    get(id) {
      const row = selectOne.get(id) as SubagentRow | undefined;
      return row ? mapSubagent(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as SubagentRow[]).map(mapSubagent);
    },
    save(subagent) {
      update.run(...(writeColumns(subagent) as never[]), subagent.id);
    },
    listByAutomation(automationId) {
      return (
        selectByAutomation.all(automationId) as unknown as SubagentRow[]
      ).map(mapSubagent);
    },
  };
}
