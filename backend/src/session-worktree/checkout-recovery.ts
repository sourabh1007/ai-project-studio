import { ValidationError } from '../kernel/error-types.js';
import type { GitRunResult } from './shared-session-checkout.js';
import type { SessionWorktreeTarget } from './session-ref-resolver.js';

export type CheckoutGitRun = (
  args: string[],
  report: (message: string) => void,
) => Promise<GitRunResult>;

export type ConfirmCheckoutRecovery = (detail: string) => Promise<boolean>;

export type CheckoutRecovery = (input: {
  target: SessionWorktreeTarget;
  cwd: string;
  report: (message: string) => void;
  confirm?: ConfirmCheckoutRecovery;
}) => Promise<string | null>;

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Existing files are never replaced; only absent managed checkouts are restored. */
export function createCheckoutRecovery(deps: {
  git: CheckoutGitRun;
  pathExists(path: string): Promise<boolean>;
  canonicalPath(path: string): Promise<string>;
}): CheckoutRecovery {
  return async ({ target, cwd, report }) => {
    if (!target.checkoutPath) return null;
    const canonical = pathKey(await deps.canonicalPath(cwd));
    if (canonical === pathKey(await deps.canonicalPath(target.repoLocalPath))) {
      throw new ValidationError('Cannot restore a managed checkout over the primary repository.');
    }
    if (await deps.pathExists(cwd)) {
      report('Keeping the current checkout and all local files. Git branch selection was skipped.');
      return cwd;
    }

    report('Restoring the deleted managed checkout…');
    const listing = await deps.git(['-C', target.repoLocalPath, 'worktree', 'list', '--porcelain', '-z'], report);
    if (listing.code !== 0) {
      throw new ValidationError(listing.stderr.trim() || 'Cannot read the saved worktree state. No files were changed.');
    }
    let saved: string[] | undefined;
    for (const entry of listing.stdout.split('\0\0').map((block) => block.split('\0'))) {
      if (entry[0].startsWith('worktree ') && pathKey(await deps.canonicalPath(entry[0].slice(9))) === canonical) {
        saved = entry;
        break;
      }
    }
    const head = saved?.find((line) => line.startsWith('HEAD '))?.slice(5);
    const candidates = [...new Set([...(head ? [head] : []), target.ref])];
    let commit = '';
    for (const ref of candidates) {
      const resolved = await deps.git(['-C', target.repoLocalPath, 'rev-parse', '--verify', `${ref}^{commit}`], report);
      if (resolved.code === 0 && resolved.stdout.trim()) {
        commit = resolved.stdout.trim();
        break;
      }
    }
    if (!commit) {
      for (const ref of [...new Set([target.ref, 'master'])]) {
        report(`Fetching ${ref} to restore the managed worktree…`);
        const fetched = await deps.git(['-C', target.repoLocalPath, 'fetch', 'origin', ref], report);
        if (fetched.code !== 0) {
          if (ref === 'master') throw new ValidationError(fetched.stderr.trim() || 'Could not fetch master to restore the checkout.');
          continue;
        }
        const resolved = await deps.git(['-C', target.repoLocalPath, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], report);
        if (resolved.code !== 0 || !resolved.stdout.trim()) {
          throw new ValidationError(resolved.stderr.trim() || `Could not resolve the fetched ${ref} commit.`);
        }
        commit = resolved.stdout.trim();
        break;
      }
    }
    if (await deps.pathExists(cwd)) {
      report('The checkout is available again; keeping its current files.');
      return cwd;
    }
    // Detaching avoids moving or sharing a branch already used by another tree.
    // A single --force restores a missing registration but does not bypass locks.
    const added = await deps.git([
      '-c', 'core.longpaths=true', '-C', target.repoLocalPath,
      'worktree', 'add', '--detach', '--force', cwd, commit,
    ], report);
    if (added.code !== 0) {
      throw new ValidationError(added.stderr.trim() || `Could not restore ${cwd}. Existing checkouts were not replaced.`);
    }
    report('Managed checkout restored at the recovered commit (detached HEAD). Files deleted from disk cannot be recovered unless committed.');
    return cwd;
  };
}
