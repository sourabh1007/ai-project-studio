/**
 * The feature tree lets a feature's work be organized into an arbitrarily-deep
 * hierarchy. Leaves are sessions; interior nodes are {@link TreeGroup}s — either
 * a user-named `subcategory` folder or a `pr` container linked to a pull
 * request. A session or group lives directly under its feature when it has no
 * parent group. The whole tree is rearrangeable via {@link FeatureTreeService.moveNode}.
 */

/** What a group represents: a plain folder or a pull-request container. */
export type TreeGroupKind = 'subcategory' | 'pr';

/** A container node under a feature. */
export interface TreeGroup {
  id: string;
  /** The feature this group (and its whole subtree) belongs to. */
  featureId: string;
  /** Parent group, or null when the group sits directly under the feature. */
  parentGroupId: string | null;
  kind: TreeGroupKind;
  name: string;
  /** Pull-request number for `pr` groups; null for subcategories. */
  prNumber: number | null;
  /** Pull-request URL for `pr` groups; null for subcategories. */
  prUrl: string | null;
  /** Sort position among its siblings (sessions and groups share the space). */
  orderIndex: number;
  createdAt: string;
}

/** Request to create a new group under a feature (optionally nested). */
export interface CreateGroupInput {
  featureId: string;
  /** Parent group id; omit/null to place the group directly under the feature. */
  parentGroupId?: string | null;
  kind: TreeGroupKind;
  name: string;
  /** Required when `kind` is `pr`. */
  prNumber?: number | null;
  /** Required when `kind` is `pr`. */
  prUrl?: string | null;
}

/** The two kinds of movable tree node. */
export type TreeNodeType = 'session' | 'group';

/** Request to move a session or group to a new container and position. */
export interface MoveNodeInput {
  type: TreeNodeType;
  id: string;
  /** Feature the node should end up under (may differ from its current one). */
  targetFeatureId: string;
  /** Destination container group, or null to drop directly under the feature. */
  targetParentGroupId: string | null;
  /** Zero-based insertion position among the destination container's children. */
  targetIndex: number;
}
