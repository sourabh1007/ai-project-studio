import type { DatabaseSync } from 'node:sqlite';
import type { GeneratedFields, TrackedWork, WorkCandidate, WorkProvenance, WorkTrackingStore } from '../planner-tracking/tracking-contract.js';
import type { TrackingContextReader } from '../planner-tracking/tracking-source.js';

interface WorkRow {
  work_key: string; task_id: string; repo_id: string | null;
  generated_json: string; locked_json: string; provenance_json: string;
}
function workFromRow(row: WorkRow): TrackedWork {
  return {
    key: row.work_key, taskId: row.task_id, repoId: row.repo_id,
    generated: JSON.parse(row.generated_json) as GeneratedFields,
    locked: JSON.parse(row.locked_json) as TrackedWork['locked'],
    provenance: JSON.parse(row.provenance_json) as WorkProvenance,
  };
}

export function createPlannerTrackingStore(db: DatabaseSync, defaultEnabled: boolean): WorkTrackingStore {
  db.prepare('INSERT OR IGNORE INTO planner_tracking_settings (id, enabled) VALUES (1, ?)').run(Number(defaultEnabled));
  return {
    enabled: () => Boolean(db.prepare('SELECT enabled FROM planner_tracking_settings WHERE id = 1').get()!.enabled),
    setEnabled: (value) => { db.prepare('UPDATE planner_tracking_settings SET enabled = ? WHERE id = 1').run(Number(value)); },
    cursor(featureId) {
      const row = db.prepare('SELECT fingerprint, retry_after FROM planner_tracking_cursors WHERE feature_id = ?').get(featureId);
      return row ? { fingerprint: row.fingerprint as string, retryAfter: row.retry_after as number } : null;
    },
    saveCursor(featureId, value) {
      db.prepare(`INSERT INTO planner_tracking_cursors (feature_id, fingerprint, retry_after) VALUES (?, ?, ?)
        ON CONFLICT(feature_id) DO UPDATE SET fingerprint = excluded.fingerprint, retry_after = excluded.retry_after`)
        .run(featureId, value.fingerprint, value.retryAfter);
    },
    candidates(repoId, featureId) {
      const work = db.prepare(`SELECT work_key, task_id, json_extract(generated_json, '$.title') AS title,
        (SELECT substr(t.pr_url, 1, 2000) FROM planner_tasks t WHERE t.id = planner_tracked_work.task_id) AS pr_url
        FROM planner_tracked_work WHERE repo_id IS ?
        AND (? IS NOT NULL OR feature_id = ?) ORDER BY updated_at DESC, work_key LIMIT 100`)
        .all(repoId, repoId, featureId).map((row) => ({
          key: row.work_key as string, taskId: row.task_id as string, title: row.title as string,
          deleted: row.pr_url === null, prUrl: row.pr_url as string | null,
        }));
      const tasks = db.prepare(`SELECT t.id, t.repo_id AS repoId, substr(t.title, 1, 200) AS title,
        substr(t.notes, 1, 2000) AS notes, t.status, substr(t.pr_url, 1, 2000) AS prUrl, t.session_id AS sessionId FROM planner_tasks t
        LEFT JOIN planner_tracked_work w ON w.task_id = t.id
        WHERE t.repo_id IS ? AND (? IS NOT NULL OR t.feature_id = ? OR w.feature_id = ?)
        ORDER BY t.updated_at DESC, t.id LIMIT 50`).all(repoId, repoId, featureId, featureId) as unknown as WorkCandidate[];
      return { tasks, work };
    },
    get(key) {
      const row = db.prepare('SELECT * FROM planner_tracked_work WHERE work_key = ?').get(key) as WorkRow | undefined;
      return row ? workFromRow(row) : null;
    },
    save(work) {
      db.prepare(`INSERT INTO planner_tracked_work
        (work_key, task_id, repo_id, feature_id, generated_json, locked_json, provenance_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_key) DO UPDATE SET generated_json = excluded.generated_json, locked_json = excluded.locked_json,
          provenance_json = excluded.provenance_json, updated_at = excluded.updated_at`)
        .run(work.key, work.taskId, work.repoId, work.provenance.featureId, JSON.stringify(work.generated),
          JSON.stringify(work.locked), JSON.stringify(work.provenance), work.provenance.updatedAt);
    },
    provenance(taskId) {
      const row = db.prepare('SELECT provenance_json FROM planner_tracked_work WHERE task_id = ?').get(taskId);
      return row ? JSON.parse(row.provenance_json as string) as WorkProvenance : null;
    },
    atomic(run) {
      db.exec('BEGIN IMMEDIATE');
      try { run(); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

/** Project only bounded, indexed source records; never deserialize full agent documents. */
export function createPlannerTrackingContext(db: DatabaseSync): TrackingContextReader {
  return {
    page(after, since) {
      return db.prepare(`SELECT f.id FROM features f WHERE f.id > ? AND (
        EXISTS(SELECT 1 FROM sessions s WHERE s.feature_id = f.id AND s.kind = 'dev'
          AND s.scope = 'feature' AND (s.status = 'running' OR COALESCE(s.ended_at, s.started_at, s.created_at) >= ?))
        OR EXISTS(SELECT 1 FROM meta_operations m WHERE m.feature_id = f.id AND m.updated_at >= ?
          AND json_extract(m.correlation_json, '$.agentId') IS NOT NULL)
      ) ORDER BY f.id LIMIT 16`).all(after, since, since).map((row) => row.id as string);
    },
    exists(featureId, repoId) {
      return Boolean(db.prepare('SELECT id FROM features WHERE id = ? AND repo_id IS ?').get(featureId, repoId));
    },
    context(featureId) {
      const feature = db.prepare('SELECT id, repo_id, substr(name, 1, 200) AS name FROM features WHERE id = ?').get(featureId);
      if (!feature) return null;
      const sessions = db.prepare(`SELECT id, provider FROM sessions WHERE feature_id = ? AND kind = 'dev'
        AND scope = 'feature' ORDER BY created_at DESC, id LIMIT 4`).all(featureId)
        .map((row) => ({ id: row.id as string, provider: row.provider as string }));
      const recorded: import('../planner-tracking/tracking-contract.js').WorkEvidence[] = [];
      const review = db.prepare(`SELECT substr(pull_url, 1, 2000) AS pull_url, substr(pull_title, 1, 2000) AS pull_title,
        created_at FROM pr_reviews WHERE feature_id = ?`).get(featureId);
      if (review) recorded.push({
        id: `pr:${featureId}`, kind: 'pr', label: 'Associated pull request',
        text: `${review.pull_url}\n${review.pull_title}`, at: review.created_at as string,
        sessionId: null, completed: false,
      });
      for (const row of db.prepare(`SELECT operation_id,
        CASE WHEN state IN ('pending', 'running') THEN 'in-progress' ELSE state END AS state,
        origin_session_id, COALESCE(finished_at, created_at) AS evidence_at,
        substr(COALESCE(label, purpose, ''), 1, 200) AS label,
        json_extract(correlation_json, '$.agentId') AS agent,
        json_extract(correlation_json, '$.perspectiveId') AS perspective,
        substr(COALESCE(result_text, error_message, ''), 1, 3000) AS result
        FROM meta_operations WHERE feature_id = ? AND json_extract(correlation_json, '$.agentId') IS NOT NULL
        ORDER BY updated_at DESC, operation_id LIMIT 4`).all(featureId)) {
        recorded.push({
          id: `agent:${row.operation_id}`, kind: 'agent', label: `${row.agent}: ${row.label}`,
          text: `Recorded state: ${row.state}; perspective: ${row.perspective}\n${row.result}`,
          at: row.evidence_at as string, sessionId: row.origin_session_id as string | null, completed: row.state === 'completed',
        });
      }
      for (const row of db.prepare(`SELECT event_id, session_id, substr(identity, 1, 1000) AS identity,
        substr(name, 1, 200) AS name, source, kind, recorded_at
        FROM skill_usage WHERE feature_id = ? AND scope = 'feature'
        ORDER BY recorded_at DESC, event_id DESC LIMIT 12`).all(featureId)) {
        recorded.push({
          id: `skill:${row.session_id}:${row.event_id}`, kind: 'skill',
          label: `${row.name} (${row.source}; ${row.kind})`,
          text: `Skill identity: ${row.identity}. Recorded activity: ${row.kind}; origin: ${row.source}.`,
          at: row.recorded_at as string, sessionId: row.session_id as string, completed: false,
        });
      }
      return { featureId, repoId: feature.repo_id as string | null, name: feature.name as string, sessions, recorded };
    },
  };
}
