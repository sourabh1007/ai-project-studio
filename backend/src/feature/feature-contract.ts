/** A feature: a unit of AI-assisted work, optionally scoped to a repository. */
export interface Feature {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  /** AI-generated cross-session summary; null until generated. */
  summary: string | null;
  /** The repository this feature belongs to; null for repo-less features. */
  repoId?: string | null;
  /**
   * Overrides the working directory this feature's sessions run in. Set for PR
   * reviews to the PR's git worktree; null to use the repository's main
   * checkout.
   */
  checkoutPath?: string | null;
  /**
   * Parent feature this one is nested under in the explorer tree; null for a
   * top-level feature. Set when a PR review is opened from within an existing
   * feature, so the PR's review feature (with its own worktree + Review Board)
   * renders as a child of that feature instead of as a sibling.
   */
  parentFeatureId?: string | null;
  /**
   * Subcategory (folder) group this feature is nested under, when placed
   * inside another feature's tree alongside its sessions and groups instead
   * of directly under a feature/repository. Mutually exclusive with
   * `parentFeatureId`: at most one of the two is set at a time. The group's
   * owning feature (`TreeGroup.featureId`) is this feature's effective
   * parent for repository inheritance and cycle checks.
   */
  parentGroupId?: string | null;
  /**
   * Sort position among sibling features that share the same repository group
   * (repo-less features form their own group). Lower sorts first; ties fall
   * back to creation order. Defaults to 0 until a feature is reordered.
   */
  orderIndex?: number;
}

export interface CreateFeatureInput {
  name: string;
  description: string;
  /** Repository to scope the feature (and its sessions) to. */
  repoId?: string | null;
  /** Working directory override (a PR worktree); null for the repo checkout. */
  checkoutPath?: string | null;
  /** Parent feature to nest this one under; null/omitted for a top-level feature. */
  parentFeatureId?: string | null;
  /**
   * Subcategory group to place this feature inside; null/omitted for a
   * top-level feature. Mutually exclusive with `parentFeatureId`. The feature
   * inherits the group's owning feature's repository.
   */
  parentGroupId?: string | null;
}

/**
 * Request to move a feature to a new repository group and/or position within
 * the left-panel explorer via drag-and-drop.
 */
export interface MoveFeatureInput {
  id: string;
  /** Destination repository group, or null for the repo-less group. */
  targetRepoId: string | null;
  /** Zero-based insertion position among the destination group's features. */
  targetIndex: number;
  /**
   * Feature to nest the moved feature under, or null to place it at the top
   * level of the destination repository group. When set, the moved feature
   * inherits its new parent's repository and is reordered among that parent's
   * children. Nesting a feature under itself or one of its own descendants is
   * rejected.
   */
  targetParentFeatureId?: string | null;
  /**
   * Subcategory group to place the moved feature inside, or null to leave it
   * out of any subcategory. When set, the moved feature inherits the group's
   * owning feature's repository, is reordered among that group's member
   * features, and its `parentFeatureId` is cleared (the two are mutually
   * exclusive). Placing a feature inside a group owned by itself or one of its
   * descendants is rejected. Takes precedence over `targetParentFeatureId`.
   */
  targetParentGroupId?: string | null;
}
