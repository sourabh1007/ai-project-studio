import type { DatabaseSync } from 'node:sqlite';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureRepo } from '../feature/feature-repo-port.js';

interface FeatureRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  summary: string | null;
  repo_id: string | null;
}

function mapFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    summary: row.summary,
    repoId: row.repo_id ?? null,
  };
}

/** SQLite-backed implementation of the FeatureRepo port. */
export function createFeatureRepo(db: DatabaseSync): FeatureRepo {
  const insert = db.prepare(
    'INSERT INTO features (id, name, description, created_at, summary, repo_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare('SELECT * FROM features WHERE id = ?');
  const selectAll = db.prepare('SELECT * FROM features ORDER BY created_at, id');
  const updateSummary = db.prepare('UPDATE features SET summary = ? WHERE id = ?');
  const updateName = db.prepare('UPDATE features SET name = ? WHERE id = ?');
  const deleteOne = db.prepare('DELETE FROM features WHERE id = ?');

  return {
    create(feature) {
      insert.run(
        feature.id,
        feature.name,
        feature.description,
        feature.createdAt,
        feature.summary,
        feature.repoId ?? null,
      );
    },
    get(id) {
      const row = selectOne.get(id) as FeatureRow | undefined;
      return row ? mapFeature(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as FeatureRow[]).map(mapFeature);
    },
    setSummary(id, summary) {
      updateSummary.run(summary, id);
    },
    rename(id, name) {
      updateName.run(name, id);
    },
    delete(id) {
      deleteOne.run(id);
    },
  };
}
