import type { DatabaseSync } from 'node:sqlite';
import type { FeatureSummary } from '../summarizer/summarizer-contract.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';

interface SummaryRow {
  feature_id: string;
  content: string;
  created_at: string;
}

/** SQLite-backed implementation of the SummaryStore port. */
export function createSummaryRepo(db: DatabaseSync): SummaryStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO summaries (feature_id, content, created_at)
     VALUES (?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM summaries WHERE feature_id = ?');
  const deleteOne = db.prepare('DELETE FROM summaries WHERE feature_id = ?');

  return {
    save(summary: FeatureSummary) {
      upsert.run(summary.featureId, summary.content, summary.createdAt);
    },
    load(featureId: string) {
      const row = selectOne.get(featureId) as SummaryRow | undefined;
      if (!row) {
        return null;
      }
      return {
        featureId: row.feature_id,
        content: row.content,
        createdAt: row.created_at,
      };
    },
    delete(featureId: string) {
      deleteOne.run(featureId);
    },
  };
}
