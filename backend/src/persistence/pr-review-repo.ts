import type { DatabaseSync } from 'node:sqlite';
import type {
  PrReview,
  PrReviewRepo,
  PrReviewStepStatus,
} from '../pr-review/pr-review-contract.js';

interface PrReviewRow {
  feature_id: string;
  document: string | null;
}

/**
 * The persisted shape of a review: everything except the primary key lives in a
 * single JSON `document` column. The structured, per-step artifact is too wide
 * for fixed columns and only ever read whole by feature id, so a JSON blob keeps
 * the schema stable as the review shape evolves.
 */
type PrReviewDocument = Omit<PrReview, 'featureId'>;

/** A fresh, un-run step used when migrating/back-filling a review document. */
function pendingStep() {
  return {
    status: 'pending' as PrReviewStepStatus,
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [] as string[],
    generatedAt: null,
  };
}

/** Back-fills the `activity` log on a step persisted before it existed. */
function withActivity<T extends { activity?: unknown }>(step: T): T {
  return Array.isArray(step.activity) ? step : { ...step, activity: [] };
}

/** A fresh, un-run change-graph step (empty reference graph). */
function pendingChangeGraph() {
  return { ...pendingStep(), projects: [], nodes: [], edges: [] };
}

/**
 * True when a persisted change-graph step predates the reference-graph redesign
 * (it carried `modules`/`files` hubs instead of `projects`/`nodes`/`edges`).
 */
function isLegacyChangeGraph(step: Record<string, unknown>): boolean {
  return !Array.isArray(step.nodes) || !Array.isArray(step.edges);
}

/**
 * Coerces a persisted document into the current two-step review shape. Older
 * databases stored a single-summary document, or the previous four-step shape,
 * without the change-graph field; those legacy rows are migrated on read to a
 * valid (pending) two-step review so the service never dereferences a missing
 * step. Reviews whose change graph used the old `modules`/`files` hub model are
 * reset to a pending reference graph so a re-run regenerates it deterministically.
 * PR identity, worktree and timestamps are preserved so a re-run can regenerate
 * every step in place.
 */
function normalizeDocument(
  featureId: string,
  doc: PrReviewDocument & Partial<Record<string, unknown>>,
): PrReview {
  const legacy = doc as unknown as {
    repoId: string;
    pull: PrReview['pull'];
    worktreePath: string;
    baseBranch: string | null;
    description?: string | null;
    changedFiles: number | null;
    timestamps: PrReview['timestamps'];
  };
  if (doc.problemStatement && doc.changeGraph) {
    const changeGraph = isLegacyChangeGraph(
      doc.changeGraph as unknown as Record<string, unknown>,
    )
      ? pendingChangeGraph()
      : withActivity(doc.changeGraph);
    return {
      featureId,
      ...(doc as PrReviewDocument),
      headSha: (doc as { headSha?: string | null }).headSha ?? null,
      problemStatement: withActivity(doc.problemStatement),
      changeGraph,
    };
  }
  return {
    featureId,
    repoId: legacy.repoId,
    pull: legacy.pull,
    worktreePath: legacy.worktreePath,
    headSha: null,
    baseBranch: legacy.baseBranch ?? null,
    description: legacy.description ?? null,
    problemStatement: { ...pendingStep(), content: null, sufficient: true },
    changeGraph: pendingChangeGraph(),
    changedFiles: legacy.changedFiles ?? null,
    timestamps: legacy.timestamps,
  };
}

/**
 * A coarse overall status for the legacy `status` column (kept NOT NULL for
 * older databases). The authoritative per-step statuses live in `document`.
 */
function overallStatus(review: PrReview): PrReviewStepStatus {
  const steps = [review.problemStatement, review.changeGraph];
  if (steps.some((s) => s.status === 'generating')) {
    return 'generating';
  }
  if (steps.some((s) => s.status === 'failed')) {
    return 'failed';
  }
  if (steps.every((s) => s.status === 'ready')) {
    return 'ready';
  }
  return 'pending';
}

/** SQLite-backed persistence for AI-generated PR reviews. */
export function createPrReviewRepo(db: DatabaseSync): PrReviewRepo {
  const upsert = db.prepare(
    `INSERT INTO pr_reviews (
       feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
       base_branch, status, summary, core_analysis, changed_files,
       created_at, updated_at, generated_at, failure_message, failed_at, document
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(feature_id) DO UPDATE SET
       repo_id = excluded.repo_id,
       pull_number = excluded.pull_number,
       pull_title = excluded.pull_title,
       pull_url = excluded.pull_url,
       worktree_path = excluded.worktree_path,
       base_branch = excluded.base_branch,
       status = excluded.status,
       changed_files = excluded.changed_files,
       updated_at = excluded.updated_at,
       document = excluded.document`,
  );
  const selectOne = db.prepare(
    'SELECT feature_id, document FROM pr_reviews WHERE feature_id = ?',
  );
  const selectAll = db.prepare('SELECT feature_id, document FROM pr_reviews');
  const selectByPull = db.prepare(
    `SELECT feature_id FROM pr_reviews
       WHERE repo_id = ? AND pull_number = ?
       ORDER BY created_at ASC LIMIT 1`,
  );
  const deleteOne = db.prepare('DELETE FROM pr_reviews WHERE feature_id = ?');

  return {
    get(featureId) {
      const row = selectOne.get(featureId) as PrReviewRow | undefined;
      if (!row || !row.document) {
        return null;
      }
      const doc = JSON.parse(row.document) as PrReviewDocument;
      return normalizeDocument(row.feature_id, doc);
    },
    listAll() {
      const rows = selectAll.all() as unknown as PrReviewRow[];
      return rows
        .filter((row): row is PrReviewRow & { document: string } =>
          row.document !== null,
        )
        .map((row) =>
          normalizeDocument(
            row.feature_id,
            JSON.parse(row.document) as PrReviewDocument,
          ),
        );
    },
    findFeatureByPull(repoId, pullNumber) {
      const row = selectByPull.get(repoId, pullNumber) as
        | { feature_id: string }
        | undefined;
      return row?.feature_id ?? null;
    },
    save(review) {
      const { featureId, ...doc } = review;
      upsert.run(
        featureId,
        review.repoId,
        review.pull.number,
        review.pull.title,
        review.pull.url,
        review.worktreePath,
        review.baseBranch,
        overallStatus(review),
        review.changedFiles,
        review.timestamps.createdAt,
        review.timestamps.updatedAt,
        JSON.stringify(doc),
      );
    },
    delete(featureId) {
      deleteOne.run(featureId);
    },
  };
}
