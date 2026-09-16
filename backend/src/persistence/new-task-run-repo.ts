import type { DatabaseSync } from 'node:sqlite';
import type {
  NewTaskAgent,
  NewTaskRun,
  NewTaskRunRepo,
  NewTaskStatus,
} from '../new-task/new-task-contract.js';

interface NewTaskRunRow {
  id: string;
  feature_id: string;
  problem: string;
  context: string;
  plan: string | null;
  status: string;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  review_feature_id: string | null;
  error: string | null;
  agents: string | null;
  created_at: string;
  updated_at: string;
}

/** Parse the persisted agents JSON, tolerating null/legacy/corrupt values. */
function parseAgents(raw: string | null): NewTaskAgent[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NewTaskAgent[]) : [];
  } catch {
    return [];
  }
}

function mapRun(row: NewTaskRunRow): NewTaskRun {
  return {
    id: row.id,
    featureId: row.feature_id,
    problem: row.problem,
    context: row.context,
    plan: row.plan,
    status: row.status as NewTaskStatus,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    reviewFeatureId: row.review_feature_id,
    error: row.error,
    agents: parseAgents(row.agents),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed implementation of {@link NewTaskRunRepo}. */
export function createNewTaskRunRepo(db: DatabaseSync): NewTaskRunRepo {
  const selectById = db.prepare('SELECT * FROM new_task_runs WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO new_task_runs (
      id, feature_id, problem, context, plan, status, branch,
      pr_number, pr_url, review_feature_id, error, agents, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE new_task_runs SET
      feature_id = ?, problem = ?, context = ?, plan = ?, status = ?,
      branch = ?, pr_number = ?, pr_url = ?, review_feature_id = ?,
      error = ?, agents = ?, updated_at = ?
    WHERE id = ?`,
  );
  const deleteById = db.prepare('DELETE FROM new_task_runs WHERE id = ?');
  const deleteByFeatureStmt = db.prepare(
    'DELETE FROM new_task_runs WHERE feature_id = ?',
  );

  return {
    get(id) {
      const row = selectById.get(id) as NewTaskRunRow | undefined;
      return row ? mapRun(row) : null;
    },
    create(run) {
      insert.run(
        run.id,
        run.featureId,
        run.problem,
        run.context,
        run.plan,
        run.status,
        run.branch,
        run.prNumber,
        run.prUrl,
        run.reviewFeatureId,
        run.error,
        JSON.stringify(run.agents ?? []),
        run.createdAt,
        run.updatedAt,
      );
    },
    update(run) {
      update.run(
        run.featureId,
        run.problem,
        run.context,
        run.plan,
        run.status,
        run.branch,
        run.prNumber,
        run.prUrl,
        run.reviewFeatureId,
        run.error,
        JSON.stringify(run.agents ?? []),
        run.updatedAt,
        run.id,
      );
    },
    delete(id) {
      deleteById.run(id);
    },
    deleteByFeature(featureId) {
      deleteByFeatureStmt.run(featureId);
    },
  };
}
