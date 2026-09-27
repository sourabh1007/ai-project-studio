import type { Feature } from '../feature/feature-contract.js';
import type { Repository } from '../repo/repo-contract.js';
import type { FeatureBranchReader } from '../feature/feature-environment.js';
import { ValidationError } from '../kernel/error-types.js';

/** Where a new session's worktree is added from, and the ref it starts on. */
export interface SessionWorktreeTarget {
  /** The repository's primary checkout the worktree is added from. */
  repoLocalPath: string;
  /** The branch/ref a new session's worktree starts on. */
  ref: string;
  /** PR sessions reuse the feature's existing review checkout. */
  checkoutPath?: string;
}

export interface SessionRefResolverDeps {
  /** Looks up the feature a session belongs to. */
  getFeature: (featureId: string) => Feature | null;
  /** Looks up the repository's primary local checkout. */
  getRepo: (repoId: string) => Repository | null;
  /** Reads the branch currently checked out at a path (the PR worktree). */
  branch: FeatureBranchReader;
  /** Prefer the PR's source branch to the mutable review checkout branch. */
  getPrBranch?: (featureId: string) => string | null;
  isPrFeature?: (featureId: string) => boolean;
}

export interface SessionRefResolver {
  /**
   * Resolves the repository checkout and default ref a new session under
   * `featureId` should start on, or null when the feature has no repository
   * (a repo-less legacy feature keeps the pre-worktree behaviour).
   */
  resolve(featureId: string): Promise<SessionWorktreeTarget | null>;
}

/** The branch used when neither a PR branch nor a repo default is known. */
export const FALLBACK_DEFAULT_BRANCH = 'master';

/**
 * Decides the branch a newly opened session defaults to. A PR feature's
 * sessions default to the PR branch — the branch checked out in the feature's
 * dedicated review worktree — so reviewing a PR starts on its code. Every other
 * feature's new sessions start on master in the shared repository checkout.
 */
export function createSessionRefResolver(
  deps: SessionRefResolverDeps,
): SessionRefResolver {
  return {
    async resolve(featureId) {
      const feature = deps.getFeature(featureId);
      if (!feature?.repoId) {
        return null;
      }
      const repo = deps.getRepo(feature.repoId);
      if (!repo) {
        return null;
      }
      const isPr = deps.isPrFeature?.(featureId) ?? Boolean(feature.checkoutPath);
      const source = deps.getPrBranch?.(featureId) ?? (isPr && feature.checkoutPath
        ? await deps.branch.read(feature.checkoutPath) : null);
      if (isPr && !source) {
        throw new ValidationError('Cannot determine the PR source branch. Refresh the PR before opening a new session.');
      }
      if (isPr && !feature.checkoutPath) {
        throw new ValidationError('The PR checkout is unavailable. Refresh the PR before opening a session.');
      }
      return {
        repoLocalPath: repo.localPath, ref: source ?? FALLBACK_DEFAULT_BRANCH,
        ...(isPr ? { checkoutPath: feature.checkoutPath! } : {}),
      };
    },
  };
}
