/**
 * The working directory and git branch a feature's sessions run in. The IDE
 * derives this centrally so a session always follows its feature: a PR-review
 * feature resolves to its dedicated worktree (on the PR branch), any other
 * feature to its repository checkout (on that checkout's current branch), and a
 * repo-less legacy feature to nothing.
 */
export interface FeatureEnvironment {
  /** Absolute checkout/worktree path, or null when the feature has no repo. */
  cwd: string | null;
  /** The branch currently checked out at {@link cwd}, or null when unknown. */
  branch: string | null;
}

/** Reads the branch currently checked out in a working directory. */
export interface FeatureBranchReader {
  read(cwd: string): Promise<string | null>;
}

export interface FeatureEnvironmentResolverDeps {
  /**
   * Resolves a feature's working directory (the PR worktree, else the repo
   * checkout), returning undefined for repo-less features.
   */
  resolveCwd(featureId: string): string | undefined;
  branch: FeatureBranchReader;
}

export interface FeatureEnvironmentResolver {
  resolve(featureId: string): Promise<FeatureEnvironment>;
}

/**
 * Combines the shared cwd resolver with a branch reader so callers get the full
 * {cwd, branch} a session would launch into. Reading the branch is skipped when
 * the feature has no working directory.
 */
export function createFeatureEnvironmentResolver(
  deps: FeatureEnvironmentResolverDeps,
): FeatureEnvironmentResolver {
  return {
    async resolve(featureId) {
      const cwd = deps.resolveCwd(featureId) ?? null;
      const branch = cwd === null ? null : await deps.branch.read(cwd);
      return { cwd, branch };
    },
  };
}
