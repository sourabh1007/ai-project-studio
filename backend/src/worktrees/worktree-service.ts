import { basename, dirname, join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { ConflictError, ProviderError } from '../kernel/error-types.js';
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
  /** Rechecked after queue admission so a newly active checkout is protected. */
  isBusy?: (path: string) => boolean | Promise<boolean>;
  /** Includes independent session checkouts, even after deleting their session. */
  listCheckoutDirectories?: (repoLocalPath: string, signal?: AbortSignal) => Promise<string[]>;
  /**
   * Deletes a directory tree from disk. Defaults to `fs.rm`. `git worktree
   * remove` unregisters the worktree but, especially on Windows, can leave the
   * checkout folder behind (locked/read-only files); this guarantees the files
   * are actually reclaimed rather than just hidden from the listing.
   */
  removeDir?: (path: string) => Promise<void>;
}

function pathKey(path: string): string {
  const absolute = resolve(path).replace(/\\/g, '/');
  return absolute.replace(/^[A-Z]:.*/i, (windowsPath) => windowsPath.toLowerCase());
}

/** True when `worktreePath` is the app worktree directory of `repoLocalPath`. */
function belongsToRepo(worktreePath: string, repoLocalPath: string): boolean {
  const container = pathKey(join(dirname(repoLocalPath), APP_WORKTREE_DIR));
  // App worktrees are named `<repo>-<kind>-<id>` (e.g. `-pr-2299392`,
  // `-task-b8094ae7…`); match the repo prefix so every kind is removable, not
  // only PR review worktrees.
  const prefix = `${basename(pathKey(repoLocalPath))}-`;
  return (
    pathKey(dirname(worktreePath)) === container &&
    basename(pathKey(worktreePath)).startsWith(prefix)
  );
}

export function createWorktreeService(
  deps: WorktreeServiceDeps,
): WorktreeService {
  const removeDir =
    deps.removeDir ??
    ((path: string) =>
      rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const pending = new Map<string, Promise<void>>();
  const removals = new Map<string, NonNullable<ManagedWorktree['removal']>>();
  const cleanupPending = new Set<string>();
  const queue: (() => void)[] = [];
  let active = 0;

  function schedule(repoLocalPath: string, path: string): Promise<void> {
    const key = pathKey(path);
    const existing = pending.get(key);
    if (existing) return existing;
    if (queue.length >= 64) {
      return Promise.reject(new ConflictError('Worktree removal queue is full. Please retry shortly.'));
    }
    const task = new Promise<void>((resolveTask, rejectTask) => {
      removals.set(key, { status: 'queued', message: 'Queued for removal' });
      const start = () => {
        active += 1;
        removals.set(key, { status: 'deleting', message: 'Deleting worktree files...' });
        void removeAt(repoLocalPath, path).finally(() => {
          pending.delete(key);
          active -= 1;
          queue.shift()?.();
        }).then(() => {
          removals.delete(key);
          resolveTask();
        }, (error: unknown) => {
          removals.set(key, { status: 'failed', message: error instanceof Error ? error.message : String(error) });
          rejectTask(error);
        });
      };
      if (active < 3) start();
      else queue.push(start);
    });
    pending.set(key, task);
    return task;
  }

  async function removeAt(repoLocalPath: string, path: string): Promise<void> {
    if (deps.repos.list().some((repo) => pathKey(repo.localPath) === pathKey(path))) {
      throw new ConflictError('Cannot remove a repository’s primary checkout.');
    }
    if (await deps.isBusy?.(path)) {
      throw new ConflictError('This worktree is in use. Stop its running sessions or agents before removing it.');
    }
    const key = pathKey(path);
    if (cleanupPending.has(key)) {
      const listing = await deps.git.run(['worktree', 'list', '--porcelain'], repoLocalPath);
      if (listing.code !== 0) {
        throw new ProviderError('Cannot verify worktree metadata before retrying cleanup.');
      }
      if (parseWorktreePorcelain(listing.stdout).some((entry) => pathKey(entry.path) === key)) {
        cleanupPending.delete(key);
      }
    }
    if (!cleanupPending.has(key)) {
      const result = await deps.git.run(['worktree', 'remove', '--force', path], repoLocalPath);
      if (result.code !== 0) {
        // Session checkouts can be independent clones rather than linked trees.
        // Never bypass Git's refusal (including worktree locks) for a linked tree.
        const checkout = basename(path).startsWith(`${basename(repoLocalPath)}-session-`)
          ? await deps.git.run(['rev-parse', '--show-prefix', '--absolute-git-dir'], path)
          : null;
        const [prefix, gitDir] = checkout?.stdout.trimEnd().split(/\r?\n/) ?? [];
        if (!checkout || checkout.code !== 0 || prefix !== '' || !gitDir ||
            pathKey(gitDir) !== pathKey(join(path, '.git'))) {
          throw new ProviderError(result.stderr || 'Git could not remove this worktree. No files were deleted.');
        }
      }
      cleanupPending.add(key);
    }
    // `git worktree remove` can unregister the worktree yet leave its directory
    // on disk (Windows file locks, read-only files). Delete it explicitly so
    // the space is truly reclaimed, then prune the now-stale admin entry.
    await removeDir(path);
    removals.set(key, { status: 'deleting', message: 'Files removed; finishing Git metadata cleanup...' });
    const pruned = await deps.git.run(['worktree', 'prune'], repoLocalPath);
    if (pruned.code !== 0) {
      throw new ProviderError(pruned.stderr || 'Worktree files removed, but Git metadata cleanup failed. Refresh and retry.');
    }
    cleanupPending.delete(key);
  }

  return {
    pathForFeature: (featureId) => deps.reviews.find(featureId)?.worktreePath ?? null,
    async list(signal) {
      signal?.throwIfAborted();
      const managed: ManagedWorktree[] = [];
      for (const repo of deps.repos.list()) {
        signal?.throwIfAborted();
        const result = await deps.git.run(
          ['worktree', 'list', '--porcelain'],
          repo.localPath,
          signal,
        );
        signal?.throwIfAborted();
        if (result.code !== 0) {
          if (signal) {
            throw new ProviderError(`Cannot inventory worktrees for ${repo.name}: ${result.stderr || 'Git listing failed.'}`);
          }
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
        for (const path of await deps.listCheckoutDirectories?.(repo.localPath, signal) ?? []) {
          signal?.throwIfAborted();
          if (!belongsToRepo(path, repo.localPath) ||
              managed.some((entry) => pathKey(entry.path) === pathKey(path))) continue;
          const suffix = basename(pathKey(path)).slice(basename(pathKey(repo.localPath)).length + 1);
          if (/^(?:pr-\d+|task-[a-z0-9-]+)$/.test(suffix)) {
            managed.push({
              path, branch: null, repoId: repo.id, repoName: repo.name,
              pullNumber: pullNumberFromPath(path),
            });
            continue;
          }
          if (!suffix.startsWith('session-')) continue;
          const checkout = await deps.git.run(['rev-parse', '--show-prefix', '--abbrev-ref', 'HEAD'], path, signal);
          signal?.throwIfAborted();
          if (checkout.code !== 0 && signal) {
            throw new ProviderError(`Cannot inspect session checkout ${path}: ${checkout.stderr || 'Git inspection failed.'}`);
          }
          const [prefix, branch] = checkout.stdout.trimEnd().split(/\r?\n/);
          if (checkout.code !== 0 || prefix !== '') continue;
          managed.push({
            path, branch: branch && branch !== 'HEAD' ? branch : null,
            repoId: repo.id, repoName: repo.name, pullNumber: null,
          });
        }
      }
      signal?.throwIfAborted();
      return managed.map((entry) => {
        const removal = removals.get(pathKey(entry.path));
        return removal ? { ...entry, removal } : entry;
      });
    },

    async remove(path) {
      const owner = deps.repos
        .list()
        .find((repo) => belongsToRepo(path, repo.localPath));
      if (!owner) {
        return;
      }
      await schedule(owner.localPath, path);
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
      await schedule(repo.localPath, review.worktreePath);
    },
  };
}
