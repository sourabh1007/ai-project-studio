import type { DatabaseSync } from 'node:sqlite';
import type {
  PlannerPriority,
  PlannerTask,
  PlannerTaskKind,
  PlannerTaskStatus,
} from '../planner/planner-contract.js';
import type { PlannerRepo } from '../planner/planner-repo-port.js';

interface PlannerRow {
  automatically_tracked?: number;
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
    ...(row.automatically_tracked ? { automaticallyTracked: true } : {}),
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
  const projection = `SELECT t.*, EXISTS(SELECT 1 FROM planner_tracked_work w WHERE w.task_id = t.id)
    AS automatically_tracked FROM planner_tasks t`;
  const selectOne = db.prepare(`${projection} WHERE t.id = ?`);
  const selectAll = db.prepare(
    `${projection} ORDER BY t.date DESC, t.created_at DESC, t.id`,
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
  const clearByFeature = db.prepare(
    `UPDATE planner_tasks
       SET launch_kind = NULL, feature_id = NULL, session_id = NULL,
           launch_label = NULL
     WHERE feature_id = ?`,
  );
  const clearBySession = db.prepare(
    `UPDATE planner_tasks
       SET launch_kind = NULL, feature_id = NULL, session_id = NULL,
           launch_label = NULL
     WHERE session_id = ?`,
  );

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
    clearLaunchByFeature(featureId) {
      clearByFeature.run(featureId);
    },
    clearLaunchBySession(sessionId) {
      clearBySession.run(sessionId);
    },
  };
}
