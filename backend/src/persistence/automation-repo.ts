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
  source: string;
  phase: string;
  scheduled_for_at: string | null;
  occurrence_key: string | null;
  dedupe_key: string | null;
  started_at: string;
  dispatched_at: string | null;
  ended_at: string | null;
  triggered: number | bigint;
  status: string;
  detail: string | null;
  session_id: string | null;
  report: string | null;
  acknowledged_run_ids: string | null;
  acknowledged_snapshot_run_ids: string | null;
  resolved_by_run_id: string | null;
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
    source: row.source as AutomationRun['source'],
    phase: row.phase as AutomationRun['phase'],
    scheduledForAt: row.scheduled_for_at,
    occurrenceKey: row.occurrence_key,
    dedupeKey: row.dedupe_key,
    startedAt: row.started_at,
    dispatchedAt: row.dispatched_at,
    endedAt: row.ended_at,
    triggered: Number(row.triggered) === 1,
    status: row.status as AutomationRun['status'],
    detail: row.detail,
    sessionId: row.session_id,
    report: row.report,
    acknowledgedRunIds:
      row.acknowledged_run_ids === null
        ? null
        : (JSON.parse(row.acknowledged_run_ids) as string[]),
    acknowledgedSnapshotRunIds:
      row.acknowledged_snapshot_run_ids === null
        ? null
        : (JSON.parse(row.acknowledged_snapshot_run_ids) as string[]),
    resolvedByRunId: row.resolved_by_run_id,
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
      id, automation_id, source, phase, scheduled_for_at, occurrence_key,
      dedupe_key, started_at, dispatched_at, ended_at, triggered, status,
      detail, session_id, report, acknowledged_run_ids, acknowledged_snapshot_run_ids,
      resolved_by_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRun = db.prepare(
    `UPDATE automation_runs SET
      automation_id = ?, source = ?, phase = ?, scheduled_for_at = ?,
      occurrence_key = ?, dedupe_key = ?, started_at = ?, dispatched_at = ?,
      ended_at = ?, triggered = ?, status = ?, detail = ?, session_id = ?, report = ?,
      acknowledged_run_ids = ?, acknowledged_snapshot_run_ids = ?,
      resolved_by_run_id = ?
     WHERE id = ?`,
  );
  const selectRun = db.prepare('SELECT * FROM automation_runs WHERE id = ?');
  const selectOpenRun = db.prepare(
    `SELECT * FROM automation_runs
     WHERE automation_id = ?
       AND phase IN ('queued', 'checking', 'acting')
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  );
  const selectOpenRuns = db.prepare(
    `SELECT * FROM automation_runs
     WHERE phase IN ('queued', 'checking', 'acting')
     ORDER BY started_at, id`,
  );
  const selectRuns = db.prepare(
    'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id',
  );
  const selectPendingUncertainRuns = db.prepare(
    `SELECT * FROM automation_runs run
     WHERE run.automation_id = ?
       AND run.phase = 'uncertain'
       AND run.triggered = 1
       AND run.resolved_by_run_id IS NULL
       AND (
         run.occurrence_key IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM automation_runs resolved
           WHERE resolved.automation_id = run.automation_id
             AND resolved.phase = 'finished'
             AND resolved.triggered = 1
             AND resolved.status = 'ok'
             AND resolved.occurrence_key = run.occurrence_key
             AND resolved.id != run.id
             AND resolved.started_at >= run.started_at
         )
       )
     ORDER BY run.started_at DESC, run.id DESC`,
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
  const writeRunColumns = (run: AutomationRun): unknown[] => [
    run.automationId,
    run.source,
    run.phase,
    run.scheduledForAt,
    run.occurrenceKey,
    run.dedupeKey,
    run.startedAt,
    run.dispatchedAt,
    run.endedAt,
    run.triggered ? 1 : 0,
    run.status,
    run.detail,
    run.sessionId,
    run.report ?? null,
    run.acknowledgedRunIds === null || run.acknowledgedRunIds === undefined
      ? null
      : JSON.stringify(run.acknowledgedRunIds),
    run.acknowledgedSnapshotRunIds === null ||
    run.acknowledgedSnapshotRunIds === undefined
      ? null
      : JSON.stringify(run.acknowledgedSnapshotRunIds),
    run.resolvedByRunId ?? null,
  ];
  let transactionDepth = 0;
  let transactionSequence = 0;

  const beginTransaction = (name: string | null): void => {
    if (name === null) {
      db.exec('BEGIN IMMEDIATE');
      return;
    }
    db.exec(`SAVEPOINT ${name}`);
  };

  const commitTransaction = (name: string | null): void => {
    if (name === null) {
      db.exec('COMMIT');
      return;
    }
    db.exec(`RELEASE SAVEPOINT ${name}`);
  };

  const rollbackTransaction = (name: string | null): void => {
    if (name === null) {
      db.exec('ROLLBACK');
      return;
    }
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
  };

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
      insertRun.run(run.id, ...(writeRunColumns(run) as never[]));
    },
    getRun(id) {
      const row = selectRun.get(id) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    saveRun(run) {
      updateRun.run(...(writeRunColumns(run) as never[]), run.id);
    },
    findOpenRun(automationId) {
      const row = selectOpenRun.get(automationId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },
    listOpenRuns() {
      return (selectOpenRuns.all() as unknown as RunRow[]).map(mapRun);
    },
    listRuns(automationId) {
      return (selectRuns.all(automationId) as unknown as RunRow[]).map(mapRun);
    },
    listPendingUncertainRuns(automationId) {
      return (selectPendingUncertainRuns.all(automationId) as unknown as RunRow[]).map(
        mapRun,
      );
    },
    transact(work) {
      const savepoint =
        transactionDepth === 0
          ? null
          : `automation_repo_${++transactionSequence}`;
      beginTransaction(savepoint);
      transactionDepth += 1;
      try {
        const result = work();
        transactionDepth -= 1;
        commitTransaction(savepoint);
        return result;
      } catch (error) {
        transactionDepth = Math.max(0, transactionDepth - 1);
        rollbackTransaction(savepoint);
        throw error;
      }
    },
  };
}
