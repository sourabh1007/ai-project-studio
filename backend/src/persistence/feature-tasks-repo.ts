import type { DatabaseSync } from 'node:sqlite';
import type {
  FeatureTask,
  FeatureTaskStatus,
} from '../feature-tasks/feature-tasks-contract.js';
import type { FeatureTasksRepo } from '../feature-tasks/feature-tasks-repo-port.js';

interface TaskRow {
  id: string;
  feature_id: string;
  title: string;
  detail: string;
  status: string;
  position: number | bigint;
  created_at: string;
}

function mapTask(row: TaskRow): FeatureTask {
  return {
    id: row.id,
    featureId: row.feature_id,
    title: row.title,
    detail: row.detail,
    status: row.status as FeatureTaskStatus,
    position: Number(row.position),
    createdAt: row.created_at,
  };
}

/** SQLite-backed implementation of the FeatureTasksRepo port. */
export function createFeatureTasksRepo(db: DatabaseSync): FeatureTasksRepo {
  const insert = db.prepare(
    `INSERT INTO feature_tasks (id, feature_id, title, detail, status, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM feature_tasks WHERE id = ?');
  const selectByFeature = db.prepare(
    'SELECT * FROM feature_tasks WHERE feature_id = ? ORDER BY position, created_at, id',
  );
  const updateStatusRow = db.prepare(
    'UPDATE feature_tasks SET status = ? WHERE id = ?',
  );
  const deleteRow = db.prepare('DELETE FROM feature_tasks WHERE id = ?');
  const deleteByFeatureRow = db.prepare(
    'DELETE FROM feature_tasks WHERE feature_id = ?',
  );
  const maxPositionRow = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS maxPosition FROM feature_tasks WHERE feature_id = ?',
  );

  return {
    create(task) {
      insert.run(
        task.id,
        task.featureId,
        task.title,
        task.detail,
        task.status,
        task.position,
        task.createdAt,
      );
    },
    get(id) {
      const row = selectOne.get(id) as TaskRow | undefined;
      return row ? mapTask(row) : null;
    },
    listByFeature(featureId) {
      return (selectByFeature.all(featureId) as unknown as TaskRow[]).map(mapTask);
    },
    updateStatus(id, status) {
      updateStatusRow.run(status, id);
    },
    delete(id) {
      deleteRow.run(id);
    },
    deleteByFeature(featureId) {
      deleteByFeatureRow.run(featureId);
    },
    maxPosition(featureId) {
      const row = maxPositionRow.get(featureId) as {
        maxPosition: number | bigint;
      };
      return Number(row.maxPosition);
    },
  };
}
