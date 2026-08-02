import type { PrReviewConfig } from './config.js';
import type {
  PrDiff,
  PrDiffCollector,
  PrDiffRequest,
} from './pr-review-contract.js';

/** Result of running a git subcommand. */
export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thin git port: runs a subcommand in a working directory. */
export interface PrDiffGit {
  run(args: string[], cwd: string): Promise<GitCommandResult>;
}

export interface PrDiffCollectorDeps {
  git: PrDiffGit;
  config: Pick<PrReviewConfig, 'maxPatchChars'>;
}

function ensureOk(result: GitCommandResult, action: string): string {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new Error(`git ${action} failed: ${detail}`);
  }
  return result.stdout;
}

function countChangedFiles(nameOutput: string): number {
  return nameOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
}

/**
 * Collects a bounded diff of a PR worktree against its base branch. The diff is
 * taken with three-dot range semantics (`base...HEAD`) so it reflects only the
 * PR's own commits, and the patch is clamped to the configured budget so the
 * review prompt stays within model limits.
 */
export function createPrDiffCollector(deps: PrDiffCollectorDeps): PrDiffCollector {
  return {
    async collect(request: PrDiffRequest): Promise<PrDiff> {
      const baseRef = request.baseBranch ? `origin/${request.baseBranch}` : null;
      const range = baseRef ? `${baseRef}...HEAD` : 'HEAD';

      const stat = ensureOk(
        await deps.git.run(['diff', '--stat', range], request.worktreePath),
        'diff --stat',
      );
      const names = ensureOk(
        await deps.git.run(['diff', '--name-only', range], request.worktreePath),
        'diff --name-only',
      );
      const patchRaw = ensureOk(
        await deps.git.run(['diff', range], request.worktreePath),
        'diff',
      );

      const max = deps.config.maxPatchChars;
      const truncated = patchRaw.length > max;
      const patch = truncated ? patchRaw.slice(0, max) : patchRaw;

      return {
        baseRef,
        changedFiles: countChangedFiles(names),
        stat,
        patch,
        truncated,
      };
    },
  };
}
