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
}

export interface CreateFeatureInput {
  name: string;
  description: string;
  /** Repository to scope the feature (and its sessions) to. */
  repoId?: string | null;
  /** Working directory override (a PR worktree); null for the repo checkout. */
  checkoutPath?: string | null;
}
