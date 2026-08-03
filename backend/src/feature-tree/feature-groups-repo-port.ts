import type { TreeGroup } from './feature-tree-contract.js';

/** New placement for a group when it is moved or promoted. */
export interface GroupPlacement {
  featureId: string;
  parentGroupId: string | null;
  orderIndex: number;
}

/**
 * Persistence port for feature-tree groups. Implemented by the persistence
 * module; the service depends only on this interface so it stays pure.
 */
export interface FeatureGroupsRepo {
  /** Every group belonging to a feature (any depth), in no particular order. */
  listByFeature(featureId: string): TreeGroup[];
  get(id: string): TreeGroup | null;
  /** Insert or update a group by id. */
  save(group: TreeGroup): void;
  updateName(id: string, name: string): void;
  /** Re-homes a group to a feature/parent and sets its sort position. */
  updatePlacement(id: string, placement: GroupPlacement): void;
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
}
