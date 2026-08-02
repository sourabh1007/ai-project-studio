import type { DatabaseSync } from 'node:sqlite';
import type {
  PrReview,
  PrReviewRepo,
  PrReviewStatus,
} from '../pr-review/pr-review-contract.js';

interface PrReviewRow {
  feature_id: string;
  repo_id: string;
  pull_number: number;
  pull_title: string;
  pull_url: string;
  worktree_path: string;
  base_branch: string | null;
  status: string;
  summary: string | null;
  core_analysis: string | null;
  changed_files: number | null;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
  failure_message: string | null;
  failed_at: string | null;
}

function mapPrReview(row: PrReviewRow): PrReview {
  const hasFailure = row.failure_message !== null && row.failed_at !== null;
  return {
    featureId: row.feature_id,
    repoId: row.repo_id,
    pull: {
      number: row.pull_number,
      title: row.pull_title,
      url: row.pull_url,
    },
    worktreePath: row.worktree_path,
    baseBranch: row.base_branch,
    status: row.status as PrReviewStatus,
    summary: row.summary,
    coreAnalysis: row.core_analysis,
    changedFiles: row.changed_files,
    timestamps: {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      generatedAt: row.generated_at,
    },
    failure: hasFailure
      ? {
          message: row.failure_message as string,
          failedAt: row.failed_at as string,
        }
      : null,
  };
}

/** SQLite-backed persistence for AI-generated PR reviews. */
export function createPrReviewRepo(db: DatabaseSync): PrReviewRepo {
  const upsert = db.prepare(
    `INSERT INTO pr_reviews (
       feature_id, repo_id, pull_number, pull_title, pull_url, worktree_path,
       base_branch, status, summary, core_analysis, changed_files,
       created_at, updated_at, generated_at, failure_message, failed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(feature_id) DO UPDATE SET
       repo_id = excluded.repo_id,
       pull_number = excluded.pull_number,
       pull_title = excluded.pull_title,
       pull_url = excluded.pull_url,
       worktree_path = excluded.worktree_path,
       base_branch = excluded.base_branch,
       status = excluded.status,
       summary = COALESCE(excluded.summary, pr_reviews.summary),
       core_analysis = COALESCE(excluded.core_analysis, pr_reviews.core_analysis),
       changed_files = COALESCE(excluded.changed_files, pr_reviews.changed_files),
       updated_at = excluded.updated_at,
       generated_at = COALESCE(excluded.generated_at, pr_reviews.generated_at),
       failure_message = excluded.failure_message,
       failed_at = excluded.failed_at`,
  );
  const selectOne = db.prepare('SELECT * FROM pr_reviews WHERE feature_id = ?');
  const deleteOne = db.prepare('DELETE FROM pr_reviews WHERE feature_id = ?');

  return {
    get(featureId) {
      const row = selectOne.get(featureId) as PrReviewRow | undefined;
      return row ? mapPrReview(row) : null;
    },
    save(review) {
      upsert.run(
        review.featureId,
        review.repoId,
        review.pull.number,
        review.pull.title,
        review.pull.url,
        review.worktreePath,
        review.baseBranch,
        review.status,
        review.summary,
        review.coreAnalysis,
        review.changedFiles,
        review.timestamps.createdAt,
        review.timestamps.updatedAt,
        review.timestamps.generatedAt,
        review.failure?.message ?? null,
        review.failure?.failedAt ?? null,
      );
    },
    delete(featureId) {
      deleteOne.run(featureId);
    },
  };
}
