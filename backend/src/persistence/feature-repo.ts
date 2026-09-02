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
  checkout_path: string | null;
  parent_feature_id: string | null;
  order_index: number;
}

function mapFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    summary: row.summary,
    repoId: row.repo_id ?? null,
    checkoutPath: row.checkout_path ?? null,
    parentFeatureId: row.parent_feature_id ?? null,
    orderIndex: row.order_index,
  };
}

/** SQLite-backed implementation of the FeatureRepo port. */
export function createFeatureRepo(db: DatabaseSync): FeatureRepo {
  const insert = db.prepare(
    'INSERT INTO features (id, name, description, created_at, summary, repo_id, checkout_path, parent_feature_id, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare('SELECT * FROM features WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM features ORDER BY order_index, created_at, id',
  );
  const updateSummary = db.prepare('UPDATE features SET summary = ? WHERE id = ?');
  const updateName = db.prepare('UPDATE features SET name = ? WHERE id = ?');
  const updatePlacement = db.prepare(
    'UPDATE features SET repo_id = ?, parent_feature_id = ?, order_index = ? WHERE id = ?',
  );
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
        feature.checkoutPath ?? null,
        feature.parentFeatureId ?? null,
        feature.orderIndex ?? 0,
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
    updatePlacement(id, placement) {
      updatePlacement.run(
        placement.repoId ?? null,
        placement.parentFeatureId ?? null,
        placement.orderIndex,
        id,
      );
    },
    delete(id) {
      deleteOne.run(id);
    },
  };
}
