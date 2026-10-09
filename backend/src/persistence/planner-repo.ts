import type { DatabaseSync } from 'node:sqlite';
import type {
  PlannerPriority,
  PlannerTask,
  PlannerTaskKind,
  PlannerTaskStatus,
} from '../planner/planner-contract.js';
import type { PlannerRepo } from '../planner/planner-repo-port.js';

interface PlannerRow {
  id: string;
  title: string;
  notes: string;
  priority: string;
  status: string;
  kind: string;
  pr_url: string;
  date: string;
  repo_id: string | null;
  launch_kind: string | null;
  feature_id: string | null;
  session_id: string | null;
  launch_label: string | null;
  backlogged_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapTask(row: PlannerRow): PlannerTask {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    priority: row.priority as PlannerPriority,
    status: row.status as PlannerTaskStatus,
    kind: row.kind as PlannerTaskKind,
    prUrl: row.pr_url,
    date: row.date,
    repoId: row.repo_id,
    launchKind: row.launch_kind as PlannerTask['launchKind'],
    featureId: row.feature_id,
    sessionId: row.session_id,
    launchLabel: row.launch_label,
    backloggedAt: row.backlogged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed implementation of the PlannerRepo port. */
export function createPlannerRepo(db: DatabaseSync): PlannerRepo {
  const insert = db.prepare(
    `INSERT INTO planner_tasks
       (id, title, notes, priority, status, kind, pr_url, date,
        repo_id, launch_kind, feature_id, session_id, launch_label,
        backlogged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM planner_tasks WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM planner_tasks ORDER BY date DESC, created_at DESC, id',
  );
  const updateRow = db.prepare(
    `UPDATE planner_tasks
       SET title = ?, notes = ?, priority = ?, status = ?, kind = ?,
           pr_url = ?, date = ?, repo_id = ?, launch_kind = ?,
           feature_id = ?, session_id = ?, launch_label = ?,
           backlogged_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const deleteRow = db.prepare('DELETE FROM planner_tasks WHERE id = ?');

  return {
    create(task) {
      insert.run(
        task.id,
        task.title,
        task.notes,
        task.priority,
        task.status,
        task.kind,
        task.prUrl,
        task.date,
        task.repoId,
        task.launchKind,
        task.featureId,
        task.sessionId,
        task.launchLabel,
        task.backloggedAt,
        task.createdAt,
        task.updatedAt,
      );
    },
    get(id) {
      const row = selectOne.get(id) as PlannerRow | undefined;
      return row ? mapTask(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as PlannerRow[]).map(mapTask);
    },
    update(task) {
      updateRow.run(
        task.title,
        task.notes,
        task.priority,
        task.status,
        task.kind,
        task.prUrl,
        task.date,
        task.repoId,
        task.launchKind,
        task.featureId,
        task.sessionId,
        task.launchLabel,
        task.backloggedAt,
        task.updatedAt,
        task.id,
      );
    },
    delete(id) {
      deleteRow.run(id);
    },
  };
}
