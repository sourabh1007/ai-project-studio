import { basename, dirname, join } from 'node:path';
import type { Repository } from '../repo/repo-contract.js';
import {
  APP_WORKTREE_DIR,
  isAppWorktree,
  parseWorktreePorcelain,
  pullNumberFromPath,
} from './worktree-list-parser.js';
import type {
  ManagedWorktree,
  WorktreeGit,
  WorktreeService,
} from './worktree-contract.js';

/** The minimal review shape the service needs to locate a feature's worktree. */
export interface WorktreeReviewLookup {
  find(featureId: string): { repoId: string; worktreePath: string } | null;
}

export interface WorktreeServiceDeps {
  /** Enumerates and resolves the repositories worktrees can belong to. */
  repos: { list(): Repository[]; get(id: string): Repository | null };
  /** Resolves the worktree a feature's PR review checked out into. */
  reviews: WorktreeReviewLookup;
  git: WorktreeGit;
}

/** True when `worktreePath` is the app worktree directory of `repoLocalPath`. */
function belongsToRepo(worktreePath: string, repoLocalPath: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const container = norm(join(dirname(repoLocalPath), APP_WORKTREE_DIR));
  const prefix = `${basename(repoLocalPath)}-pr-`;
  return (
    norm(dirname(worktreePath)) === container &&
    basename(worktreePath).startsWith(prefix)
  );
}

export function createWorktreeService(
  deps: WorktreeServiceDeps,
): WorktreeService {
  async function removeAt(repoLocalPath: string, path: string): Promise<void> {
    await deps.git.run(['worktree', 'remove', '--force', path], repoLocalPath);
    await deps.git.run(['worktree', 'prune'], repoLocalPath);
  }

  return {
    async list() {
      const managed: ManagedWorktree[] = [];
      for (const repo of deps.repos.list()) {
        const result = await deps.git.run(
          ['worktree', 'list', '--porcelain'],
          repo.localPath,
        );
        if (result.code !== 0) {
          continue;
        }
        for (const entry of parseWorktreePorcelain(result.stdout)) {
          if (!isAppWorktree(entry.path)) {
            continue;
          }
          managed.push({
            path: entry.path,
            branch: entry.branch,
            repoId: repo.id,
            repoName: repo.name,
            pullNumber: pullNumberFromPath(entry.path),
          });
        }
      }
      return managed;
    },

    async remove(path) {
      const owner = deps.repos
        .list()
        .find((repo) => belongsToRepo(path, repo.localPath));
      if (!owner) {
        return;
      }
      await removeAt(owner.localPath, path);
    },

    async removeForFeature(featureId) {
      const review = deps.reviews.find(featureId);
      if (!review) {
        return;
      }
      const repo = deps.repos.get(review.repoId);
      if (!repo) {
        return;
      }
      // A review that ran in place (its head branch was already checked out in
      // the repo's primary working tree) points at a non-managed path; never
      // attempt to remove the user's own checkout.
      if (!belongsToRepo(review.worktreePath, repo.localPath)) {
        return;
      }
      await removeAt(repo.localPath, review.worktreePath);
    },
  };
}
