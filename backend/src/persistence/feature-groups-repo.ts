import type { DatabaseSync } from 'node:sqlite';
import type {
  TreeGroup,
  TreeGroupKind,
} from '../feature-tree/feature-tree-contract.js';
import type {
  FeatureGroupsRepo,
  GroupPlacement,
} from '../feature-tree/feature-groups-repo-port.js';

interface GroupRow {
  id: string;
  feature_id: string;
  parent_group_id: string | null;
  kind: string;
  name: string;
  pr_number: number | bigint | null;
  pr_url: string | null;
  order_index: number | bigint;
  created_at: string;
}

function mapGroup(row: GroupRow): TreeGroup {
  return {
    id: row.id,
    featureId: row.feature_id,
    parentGroupId: row.parent_group_id,
    kind: row.kind as TreeGroupKind,
    name: row.name,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    prUrl: row.pr_url,
    orderIndex: Number(row.order_index),
    createdAt: row.created_at,
  };
}

/** SQLite-backed implementation of the FeatureGroupsRepo port. */
export function createFeatureGroupsRepo(db: DatabaseSync): FeatureGroupsRepo {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO feature_groups
      (id, feature_id, parent_group_id, kind, name, pr_number, pr_url,
       order_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM feature_groups WHERE id = ?');
  const selectByFeature = db.prepare(
    'SELECT * FROM feature_groups WHERE feature_id = ?',
  );
  const updateNameRow = db.prepare(
    'UPDATE feature_groups SET name = ? WHERE id = ?',
  );
  const updatePlacementRow = db.prepare(
    `UPDATE feature_groups
       SET feature_id = ?, parent_group_id = ?, order_index = ?
     WHERE id = ?`,
  );
  const deleteRow = db.prepare('DELETE FROM feature_groups WHERE id = ?');
  const deleteByFeatureRow = db.prepare(
    'DELETE FROM feature_groups WHERE feature_id = ?',
  );

  return {
    listByFeature(featureId) {
      return (selectByFeature.all(featureId) as unknown as GroupRow[]).map(
        mapGroup,
      );
    },
    get(id) {
      const row = selectOne.get(id) as GroupRow | undefined;
      return row ? mapGroup(row) : null;
    },
    save(group) {
      upsert.run(
        group.id,
        group.featureId,
        group.parentGroupId,
        group.kind,
        group.name,
        group.prNumber,
        group.prUrl,
        group.orderIndex,
        group.createdAt,
      );
    },
    updateName(id, name) {
      updateNameRow.run(name, id);
    },
    updatePlacement(id, placement: GroupPlacement) {
      updatePlacementRow.run(
        placement.featureId,
        placement.parentGroupId,
        placement.orderIndex,
        id,
      );
    },
    delete(id) {
      deleteRow.run(id);
    },
    deleteByFeature(featureId) {
      deleteByFeatureRow.run(featureId);
    },
  };
}
