import { ValidationError } from '../kernel/error-types.js';
import { sessionWorktreeDefaults } from './config.js';
import type { SessionWorktreeTarget } from './session-ref-resolver.js';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** True when git failed because the checkout directory is not a Git repository. */
export function isNotGitRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

/** Serializes branch selection in a shared checkout; never creates a copy or resets work. */
export function createSharedCheckoutPreparer(deps: {
  git(args: string[], report: (message: string) => void): Promise<GitRunResult>;
  checkoutWorkers?: number;
}) {
  const pending = new Map<string, Promise<string>>();
  return async (
    target: SessionWorktreeTarget,
    report: (message: string) => void = () => {},
    selectBranch = true,
  ): Promise<string> => {
    const cwd = target.checkoutPath ?? target.repoLocalPath;
    if (!selectBranch) {
      report('Reusing the existing shared checkout…');
      return cwd;
    }
    report(`Opening ${target.ref} in the existing shared checkout…`);
    const previous = pending.get(cwd);
    const operation = (async () => {
      if (previous) await previous.catch(() => {});
      const branch = await deps.git(['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], report);
      if (isNotGitRepository(branch.stderr)) {
        report('This workspace is not a Git repository, so branch selection was skipped. Re-add the repository from Settings to restore Git tools.');
        return cwd;
      }
      if (branch.code === 0 && branch.stdout.trim() === target.ref) return cwd;
      report(`Switching the shared checkout to ${target.ref}…`);
      const result = await deps.git([
        '-c', 'core.longpaths=true', '-c', `checkout.workers=${deps.checkoutWorkers ?? sessionWorktreeDefaults.checkoutWorkers}`,
        '-C', cwd, 'checkout', '--progress', target.ref, '--',
      ], report);
      if (result.code !== 0) {
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
