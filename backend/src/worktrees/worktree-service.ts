import { basename, dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';
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
  /**
   * Deletes a directory tree from disk. Defaults to `fs.rm`. `git worktree
   * remove` unregisters the worktree but, especially on Windows, can leave the
   * checkout folder behind (locked/read-only files); this guarantees the files
   * are actually reclaimed rather than just hidden from the listing.
   */
  removeDir?: (path: string) => Promise<void>;
}

/** True when `worktreePath` is the app worktree directory of `repoLocalPath`. */
function belongsToRepo(worktreePath: string, repoLocalPath: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const container = norm(join(dirname(repoLocalPath), APP_WORKTREE_DIR));
  // App worktrees are named `<repo>-<kind>-<id>` (e.g. `-pr-2299392`,
  // `-task-b8094ae7…`); match the repo prefix so every kind is removable, not
  // only PR review worktrees.
  const prefix = `${basename(repoLocalPath)}-`;
  return (
    norm(dirname(worktreePath)) === container &&
    basename(worktreePath).startsWith(prefix)
  );
}

export function createWorktreeService(
  deps: WorktreeServiceDeps,
): WorktreeService {
  const removeDir =
    deps.removeDir ??
    ((path: string) =>
      rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  async function removeAt(repoLocalPath: string, path: string): Promise<void> {
    await deps.git.run(['worktree', 'remove', '--force', path], repoLocalPath);
    // `git worktree remove` can unregister the worktree yet leave its directory
    // on disk (Windows file locks, read-only files). Delete it explicitly so
    // the space is truly reclaimed, then prune the now-stale admin entry.
    await removeDir(path);
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
