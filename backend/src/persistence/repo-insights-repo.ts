import type { DatabaseSync } from 'node:sqlite';
import type { RepoInsights } from '../repo-insights/repo-insights-contract.js';
import type { RepoInsightsStore } from '../repo-insights/repo-insights-store-port.js';

interface RepoInsightsRow {
  repo_id: string;
  snapshot: string;
  generated_at: string;
}

function parseSnapshot(row: RepoInsightsRow): RepoInsights | null {
  try {
    const parsed = JSON.parse(row.snapshot) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as RepoInsights;
  } catch {
    return null;
  }
}

/**
 * SQLite-backed persistence for the latest completed repository insights
 * snapshot. The snapshot is stored verbatim as JSON keyed by repository id so a
 * restart (or a fresh open after the in-memory cache is gone) restores it
 * instantly without re-scanning.
 */
export function createRepoInsightsRepo(db: DatabaseSync): RepoInsightsStore {
  const upsert = db.prepare(
    `INSERT INTO repo_insights (repo_id, snapshot, generated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       snapshot = excluded.snapshot,
       generated_at = excluded.generated_at`,
  );
  const selectOne = db.prepare('SELECT * FROM repo_insights WHERE repo_id = ?');
  const deleteOne = db.prepare('DELETE FROM repo_insights WHERE repo_id = ?');

  return {
    get(repositoryId) {
      const row = selectOne.get(repositoryId) as RepoInsightsRow | undefined;
      return row ? parseSnapshot(row) : null;
    },
    save(insights) {
      upsert.run(
        insights.repositoryId,
        JSON.stringify(insights),
        insights.generatedAt,
      );
    },
    delete(repositoryId) {
      deleteOne.run(repositoryId);
    },
  };
}
