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
  bindSession?: boolean;
}

export interface SessionWorktreeChoice {
  id: string;
  checkoutPath: string;
  ref: string;
}

export type SelectSessionWorktree = (choices: SessionWorktreeChoice[]) => Promise<string | null>;
export interface SavedSessionCheckout { path: string; ref?: string }

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
  /** Existing task worktrees, resolved by the composition root, not by core. */
  getTaskCheckouts?: (featureId: string, repoLocalPath: string) => SessionWorktreeChoice[];
}

export interface SessionRefResolver {
  /** Same checkout selection for API launches and feature-move previews. */
  resolveCwd(featureId: string, taskCheckoutId?: string): string | undefined;
  choices(featureId: string): SessionWorktreeChoice[];
  /**
   * Resolves the repository checkout and default ref a new session under
   * `featureId` should start on, or null when the feature has no repository
   * (a repo-less legacy feature keeps the pre-worktree behaviour).
   */
  resolve(featureId: string, select?: SelectSessionWorktree, saved?: SavedSessionCheckout): Promise<SessionWorktreeTarget | null>;
}

/** The branch used when neither a PR branch nor a repo default is known. */
export const FALLBACK_DEFAULT_BRANCH = 'master';

/**
 * Decides the branch a newly opened session defaults to. A PR feature's
 * sessions default to the PR branch — the branch checked out in the feature's
 * dedicated review worktree — so reviewing a PR starts on its code. When that
 * source branch can't be determined (e.g. a stale/legacy PR), the session
 * degrades gracefully to the repository's default branch instead of blocking
 * the user. A planned task reuses its existing worktree and branch. Other
 * features start on the repository's default branch (`main`/`master`), falling back to {@link FALLBACK_DEFAULT_BRANCH}
 * only when the repository records no default.
 */
export function createSessionRefResolver(
  deps: SessionRefResolverDeps,
): SessionRefResolver {
  const taskCheckout = (featureId: string, repoLocalPath: string, id?: string) => {
    const tasks = deps.getTaskCheckouts?.(featureId, repoLocalPath) ?? [];
    if (id !== undefined) {
      const selected = tasks.find((task) => task.id === id);
      if (!selected) throw new ValidationError('The selected task worktree is no longer available. Choose again.');
      return selected;
    }
    if (tasks.length > 1) {
      throw new ValidationError('This feature has multiple task worktrees. Open an interactive session to choose a checkout, or supply taskCheckoutId.');
    }
    return tasks[0];
  };
  return {
    choices(featureId) {
      const feature = deps.getFeature(featureId);
      if (!feature?.repoId || feature.checkoutPath || deps.isPrFeature?.(featureId)) return [];
      const repo = deps.getRepo(feature.repoId);
      return repo ? deps.getTaskCheckouts?.(featureId, repo.localPath) ?? [] : [];
    },
    resolveCwd(featureId, taskCheckoutId) {
      const feature = deps.getFeature(featureId);
      if (feature?.checkoutPath) return feature.checkoutPath;
      if (!feature?.repoId) return undefined;
      const repo = deps.getRepo(feature.repoId);
      if (!repo) return undefined;
      if (deps.isPrFeature?.(featureId)) {
        throw new ValidationError('The PR checkout is unavailable. Refresh the PR before opening a session.');
      }
      return taskCheckout(featureId, repo.localPath, taskCheckoutId)?.checkoutPath ?? repo.localPath;
    },
    async resolve(featureId, select, saved) {
      const feature = deps.getFeature(featureId);
      if (!feature?.repoId) {
        return null;
      }
      const repo = deps.getRepo(feature.repoId);
      if (!repo) {
        return null;
      }
      if (saved) {
        return {
          repoLocalPath: repo.localPath, checkoutPath: saved.path,
          ref: saved.ref || repo.defaultBranch?.trim() || FALLBACK_DEFAULT_BRANCH,
        };
      }
      const isPr = deps.isPrFeature?.(featureId) ?? Boolean(feature.checkoutPath);
      const tasks = !isPr ? deps.getTaskCheckouts?.(featureId, repo.localPath) ?? [] : [];
      let selectedId: string | undefined;
      if (tasks.length > 1 && select) {
        const selected = await select(tasks.map((task) => ({ ...task })));
        if (selected === null) throw new ValidationError('Worktree selection cancelled. Reconnect to choose a checkout.');
        if (deps.getFeature(featureId)?.repoId !== repo.id || deps.isPrFeature?.(featureId)) {
          throw new ValidationError('The feature changed during worktree selection. Reconnect to choose again.');
        }
        const current = deps.getTaskCheckouts!(featureId, repo.localPath);
        const offered = tasks.find((task) => task.id === selected);
        if (!offered || !current.some((task) => task.id === selected && task.checkoutPath === offered.checkoutPath && task.ref === offered.ref)) {
          throw new ValidationError('The selected task worktree changed or is no longer available. Choose again.');
        }
        selectedId = selected;
      }
      const task = !isPr ? taskCheckout(featureId, repo.localPath, selectedId) : undefined;
      if (task) return { repoLocalPath: repo.localPath, checkoutPath: task.checkoutPath, ref: task.ref, bindSession: true };
      const source = deps.getPrBranch?.(featureId) ?? (isPr && feature.checkoutPath
        ? await deps.branch.read(feature.checkoutPath) : null);
      if (isPr && !feature.checkoutPath) {
        throw new ValidationError('The PR checkout is unavailable. Refresh the PR before opening a session.');
      }
      const repoDefault = repo.defaultBranch?.trim() || FALLBACK_DEFAULT_BRANCH;
      return {
        repoLocalPath: repo.localPath, ref: source ?? repoDefault,
        ...(isPr ? { checkoutPath: feature.checkoutPath! } : {}),
      };
    },
  };
}
