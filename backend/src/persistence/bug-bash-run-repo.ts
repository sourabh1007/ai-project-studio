import type { DatabaseSync } from 'node:sqlite';
import type {
  BugBashAgent,
  BugBashPrerequisite,
  BugBashRun,
  BugBashRunRepo,
  BugBashScenario,
  BugBashStatus,
} from '../bug-bash/bug-bash-contract.js';

interface BugBashRunRow {
  id: string;
  feature_id: string;
  feature_info: string;
  setup_info: string;
  other_info: string;
  prerequisites: string | null;
  scenarios: string | null;
  report: string | null;
  status: string;
  error: string | null;
  agents: string | null;
  created_at: string;
  updated_at: string;
}

/** Parse a persisted JSON array column, tolerating null/legacy/corrupt values. */
function parseArray<T>(raw: string | null): T[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Backfill scenario fields added after a run was persisted so runs stored by an
 * older build load without crashing the report UI (which reads e.g.
 * `evidenceGaps.length`). Legacy rows have no `reproScript`/`evidenceGaps`.
 */
function normalizeScenario(scenario: BugBashScenario): BugBashScenario {
  return {
    ...scenario,
    reproScript: scenario.reproScript ?? '',
    evidenceGaps: Array.isArray(scenario.evidenceGaps)
      ? scenario.evidenceGaps
      : [],
  };
}

function normalizePrerequisite(
  prerequisite: BugBashPrerequisite,
): BugBashPrerequisite {
  return {
    ...prerequisite,
    options: Array.isArray(prerequisite.options) ? prerequisite.options : [],
  };
}

function mapRun(row: BugBashRunRow): BugBashRun {
  return {
    id: row.id,
    featureId: row.feature_id,
    featureInfo: row.feature_info,
    setupInfo: row.setup_info,
    otherInfo: row.other_info,
    prerequisites: parseArray<BugBashPrerequisite>(row.prerequisites).map(
      normalizePrerequisite,
    ),
    scenarios: parseArray<BugBashScenario>(row.scenarios).map(normalizeScenario),
    report: row.report,
    status: row.status as BugBashStatus,
    error: row.error,
    agents: parseArray<BugBashAgent>(row.agents),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed implementation of {@link BugBashRunRepo}. */
export function createBugBashRunRepo(db: DatabaseSync): BugBashRunRepo {
  const selectById = db.prepare('SELECT * FROM bug_bash_runs WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO bug_bash_runs (
      id, feature_id, feature_info, setup_info, other_info, prerequisites,
      scenarios, report, status, error, agents, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE bug_bash_runs SET
      feature_id = ?, feature_info = ?, setup_info = ?, other_info = ?,
      prerequisites = ?, scenarios = ?, report = ?, status = ?, error = ?,
      agents = ?, updated_at = ?
    WHERE id = ?`,
  );
  const deleteById = db.prepare('DELETE FROM bug_bash_runs WHERE id = ?');
  const deleteByFeatureStmt = db.prepare(
    'DELETE FROM bug_bash_runs WHERE feature_id = ?',
  );

  return {
    get(id) {
      const row = selectById.get(id) as BugBashRunRow | undefined;
      return row ? mapRun(row) : null;
    },
    create(run) {
      insert.run(
        run.id,
        run.featureId,
        run.featureInfo,
        run.setupInfo,
        run.otherInfo ?? '',
        JSON.stringify(run.prerequisites ?? []),
        JSON.stringify(run.scenarios ?? []),
        run.report,
        run.status,
        run.error,
        JSON.stringify(run.agents ?? []),
        run.createdAt,
        run.updatedAt,
      );
    },
    update(run) {
      update.run(
        run.featureId,
        run.featureInfo,
        run.setupInfo,
        run.otherInfo ?? '',
        JSON.stringify(run.prerequisites ?? []),
        JSON.stringify(run.scenarios ?? []),
        run.report,
        run.status,
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
