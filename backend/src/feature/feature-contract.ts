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
}
