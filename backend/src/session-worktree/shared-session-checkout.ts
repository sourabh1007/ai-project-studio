import { ValidationError } from '../kernel/error-types.js';
import { sessionWorktreeDefaults } from './config.js';
import type { SessionWorktreeTarget } from './session-ref-resolver.js';
import type { CheckoutRecovery, ConfirmCheckoutRecovery } from './checkout-recovery.js';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when git failed because the checkout directory is not a Git repository. */
export function isNotGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/**
 * True when git refused a checkout because the target branch/ref doesn't exist
 * (e.g. the repo uses `main` but we asked for `master`). Covers both the
 * `fatal: invalid reference: <ref>` and `error: pathspec '<ref>' did not match`
 * phrasings git uses across versions.
 */
export function isMissingRef(stderr: string): boolean {
  return /invalid reference|did not match/i.test(stderr);
}

/**
 * Asks Git for the repository's actual default branch rather than guessing
 * `main`/`master`. `origin/HEAD` records the remote's default, so stripping the
 * `origin/` prefix yields the branch a fresh clone would check out. Returns null
 * when the symbolic ref is absent (e.g. a repo cloned without `--mirror` whose
 * `origin/HEAD` was never set), leaving the caller to keep the current branch.
 */
export async function detectDefaultBranch(
  git: (args: string[], report: (message: string) => void) => Promise<GitRunResult>,
  cwd: string,
  report: (message: string) => void,
): Promise<string | null> {
  const symbolic = await git(
    ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    report,
  );
  if (symbolic.code !== 0) {
    return null;
  }
  const branch = symbolic.stdout.trim().replace(/^origin\//, '');
  return branch.length > 0 ? branch : null;
}

/** Serializes shared checkout preparation without replacing existing local work. */
export function createSharedCheckoutPreparer(deps: {
  git(args: string[], report: (message: string) => void): Promise<GitRunResult>;
  pathExists?: (path: string) => Promise<boolean>;
  checkoutWorkers?: number;
  /**
   * Keeps existing managed checkouts or restores deleted ones. Returns null
   * when the primary checkout's original failure should surface.
   */
  recover?: CheckoutRecovery;
}) {
  const pending = new Map<string, Promise<string>>();
  return async (
    target: SessionWorktreeTarget,
    report: (message: string) => void = () => {},
    selectBranch = true,
    confirm?: ConfirmCheckoutRecovery,
  ): Promise<string> => {
    const cwd = target.checkoutPath ?? target.repoLocalPath;
    if (!selectBranch && !target.checkoutPath) {
      report('Reusing the existing shared checkout…');
      return cwd;
    }
    report(`Opening ${target.ref} in the existing shared checkout…`);
    const previous = pending.get(cwd);
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      if (target.checkoutPath && await deps.pathExists?.(cwd)) {
        report('Keeping the current managed checkout and its branch.');
        return cwd;
      }
      const branch = await deps.git(['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], report);
      if (isNotGitRepository(branch.stderr) || (!selectBranch && branch.code !== 0 && branch.stderr.trim().length > 0)) {
        const recovered = await deps.recover?.({ target, cwd, report, confirm });
        if (recovered) return recovered;
        if (target.checkoutPath) throw new ValidationError(branch.stderr.trim());
        report('This workspace is not a Git repository, so branch selection was skipped. Re-add the repository from Settings to restore Git tools.');
        return cwd;
      }
      if (!selectBranch || (branch.code === 0 && branch.stdout.trim() === target.ref)) return cwd;
      report(`Switching the shared checkout to ${target.ref}…`);
      const checkout = (ref: string) => deps.git([
        '-c', 'core.longpaths=true', '-c', `checkout.workers=${deps.checkoutWorkers ?? sessionWorktreeDefaults.checkoutWorkers}`,
        '-C', cwd, 'checkout', '--progress', ref, '--',
      ], report);
      const result = await checkout(target.ref);
      if (result.code !== 0) {
        if (isMissingRef(result.stderr) && !target.checkoutPath) {
          // Self-heal: the recorded default (main/master) is wrong for this
          // repo, so fall back to the branch Git itself reports as default
          // before giving up and staying on whatever is checked out.
          const detected = await detectDefaultBranch(deps.git, cwd, report);
          if (detected && detected !== target.ref && (await checkout(detected)).code === 0) {
            report(`Branch ${target.ref} was not found, so the session opened the repository's default branch ${detected} instead.`);
            return cwd;
          }
          report(`Branch ${target.ref} was not found, so the session opened on the current branch instead.`);
          return cwd;
        }
        // Recovery preserves existing files and only provisions missing trees.
        const recovered = await deps.recover?.({ target, cwd, report, confirm });
        if (recovered) return recovered;
        throw new ValidationError(result.stderr.trim() ||
          `Cannot switch the shared checkout to ${target.ref}. Resolve local changes or missing branches and retry.`);
      }
      return cwd;
    })();
    pending.set(cwd, operation);
    try { return await operation; }
    finally { if (pending.get(cwd) === operation) pending.delete(cwd); }
  };
}
