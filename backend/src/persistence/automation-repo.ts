import type { DatabaseSync } from 'node:sqlite';
import type {
  ActionSpec,
  Automation,
  AutomationMode,
  AutomationRepo,
  AutomationRun,
  AutomationStatus,
  CheckSpec,
  ConditionSpec,
  PlannedStep,
} from '../automation/automation-contract.js';

interface AutomationRow {
  id: string;
  name: string;
  mode: string;
  status: string;
  origin_session_id: string | null;
  origin_feature_id: string | null;
  check_spec: string;
  condition_spec: string;
  action_spec: string;
  interval_ms: number | bigint;
  max_runs: number | bigint | null;
  run_count: number | bigint;
  progress: string | null;
  planned_steps: string;
  last_occurrence_key: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  next_run_at: string | null;
  failure: string | null;
}

interface RunRow {
  id: string;
  automation_id: string;
  started_at: string;
  ended_at: string | null;
  triggered: number | bigint;
  status: string;
  detail: string | null;
  session_id: string | null;
}

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as AutomationMode,
    status: row.status as AutomationStatus,
    origin: {
      sessionId: row.origin_session_id,
      featureId: row.origin_feature_id,
    },
    check: JSON.parse(row.check_spec) as CheckSpec,
    condition: JSON.parse(row.condition_spec) as ConditionSpec,
    action: JSON.parse(row.action_spec) as ActionSpec,
    intervalMs: Number(row.interval_ms),
    maxRuns: row.max_runs === null ? null : Number(row.max_runs),
    runCount: Number(row.run_count),
    progress: row.progress,
    plannedSteps: JSON.parse(row.planned_steps) as PlannedStep[],
    lastOccurrenceKey: row.last_occurrence_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    nextRunAt: row.next_run_at,
    failure: row.failure,
  };
}

function mapRun(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    triggered: Number(row.triggered) === 1,
    status: row.status as AutomationRun['status'],
    detail: row.detail,
    sessionId: row.session_id,
  };
}

/** SQLite-backed implementation of the {@link AutomationRepo} port. */
export function createAutomationRepo(db: DatabaseSync): AutomationRepo {
  const insert = db.prepare(
    `INSERT INTO automations (
      id, name, mode, status, origin_session_id, origin_feature_id,
      check_spec, condition_spec, action_spec, interval_ms, max_runs,
      run_count, progress, planned_steps, last_occurrence_key,
      created_at, updated_at, last_checked_at, next_run_at, failure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE automations SET
      name = ?, mode = ?, status = ?, origin_session_id = ?,
      origin_feature_id = ?, check_spec = ?, condition_spec = ?,
      action_spec = ?, interval_ms = ?, max_runs = ?, run_count = ?,
      progress = ?, planned_steps = ?, last_occurrence_key = ?,
      created_at = ?, updated_at = ?, last_checked_at = ?, next_run_at = ?,
      failure = ?
     WHERE id = ?`,
  );
  const selectOne = db.prepare('SELECT * FROM automations WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM automations ORDER BY created_at, id',
  );
  const deleteRow = db.prepare('DELETE FROM automations WHERE id = ?');
  const deleteRuns = db.prepare(
    'DELETE FROM automation_runs WHERE automation_id = ?',
  );
  const insertRun = db.prepare(
    `INSERT INTO automation_runs (
      id, automation_id, started_at, ended_at, triggered, status, detail, session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRuns = db.prepare(
    'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id',
  );

  const writeColumns = (automation: Automation): unknown[] => [
    automation.name,
    automation.mode,
    automation.status,
    automation.origin.sessionId,
    automation.origin.featureId,
    JSON.stringify(automation.check),
    JSON.stringify(automation.condition),
    JSON.stringify(automation.action),
    automation.intervalMs,
    automation.maxRuns,
    automation.runCount,
    automation.progress,
    JSON.stringify(automation.plannedSteps),
    automation.lastOccurrenceKey,
    automation.createdAt,
    automation.updatedAt,
    automation.lastCheckedAt,
    automation.nextRunAt,
    automation.failure,
  ];

  return {
    create(automation) {
      insert.run(automation.id, ...(writeColumns(automation) as never[]));
    },
    get(id) {
      const row = selectOne.get(id) as AutomationRow | undefined;
      return row ? mapAutomation(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as AutomationRow[]).map(mapAutomation);
    },
    save(automation) {
      update.run(...(writeColumns(automation) as never[]), automation.id);
    },
    delete(id) {
      deleteRuns.run(id);
      deleteRow.run(id);
    },
    appendRun(run) {
      insertRun.run(
        run.id,
        run.automationId,
        run.startedAt,
        run.endedAt,
        run.triggered ? 1 : 0,
        run.status,
        run.detail,
        run.sessionId,
      );
    },
    listRuns(automationId) {
      return (selectRuns.all(automationId) as unknown as RunRow[]).map(mapRun);
    },
  };
}
