import type { PrReviewConfig } from './config.js';
import type {
  PrChangeKind,
  PrDiff,
  PrDiffCollector,
  PrDiffEntry,
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
  config: Pick<PrReviewConfig, 'maxPatchChars' | 'maxFileDiffChars'>;
}

function ensureOk(result: GitCommandResult, action: string): string {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new Error(`git ${action} failed: ${detail}`);
  }
  return result.stdout;
}

/** Maps a `git diff --name-status` status letter to a change kind. */
function toChangeKind(statusLetter: string): PrChangeKind {
  switch (statusLetter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

/**
 * Parses `git diff --name-status` output into ordered path/status pairs. Rename
 * and copy rows carry the destination path in their final tab-separated column.
 */
function parseNameStatus(output: string): { path: string; status: PrChangeKind }[] {
  const rows: { path: string; status: PrChangeKind }[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) {
      continue;
    }
    const cols = line.split('\t');
    const status = toChangeKind(cols[0].charAt(0));
    const path = cols[cols.length - 1].trim();
    if (path.length > 0) {
      rows.push({ path, status });
    }
  }
  return rows;
}

/** Strips a leading `a/` or `b/` diff prefix from a header path. */
function stripDiffPrefix(value: string): string {
  return value.replace(/^[ab]\//, '');
}

/**
 * Splits a unified diff into per-file segments keyed by the file's path. The
 * path is taken from the non-`/dev/null` side of the `---`/`+++` header so
 * additions, deletions and modifications all resolve to a real path.
 */
function splitPatchByFile(patch: string): Map<string, string> {
  const byPath = new Map<string, string>();
  let headerPath: string | null = null;
  let minusPath: string | null = null;
  let plusPath: string | null = null;
  let lines: string[] = [];

  const flush = (): void => {
    if (lines.length === 0) {
      return;
    }
    const resolve = (value: string | null): string | null =>
      value && value !== '/dev/null' ? stripDiffPrefix(value) : null;
    const path = resolve(plusPath) ?? resolve(minusPath) ?? headerPath;
    if (path) {
      byPath.set(path, lines.join('\n'));
    }
  };

  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      flush();
      lines = [line];
      minusPath = null;
      plusPath = null;
      const match = / b\/(.+)$/.exec(line);
      headerPath = match ? match[1].trim() : null;
      continue;
    }
    if (lines.length === 0) {
      continue;
    }
    lines.push(line);
    if (line.startsWith('--- ')) {
      minusPath = line.slice(4).trim();
    } else if (line.startsWith('+++ ')) {
      plusPath = line.slice(4).trim();
    }
  }
  flush();
  return byPath;
}

/**
 * Resolves the base branch to a ref that actually exists in the worktree. The
 * remote-tracking ref (`origin/<base>`) is preferred, but a freshly-provisioned
 * PR worktree may not have fetched it — so the plain local branch name is tried
 * next. Returns null when the base is unknown or neither ref resolves, so the
 * caller can degrade to a `HEAD` diff instead of failing.
 */
async function resolveBaseRef(
  git: PrDiffGit,
  worktreePath: string,
  baseBranch: string | null,
): Promise<string | null> {
  if (!baseBranch) {
    return null;
  }
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const res = await git.run(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      worktreePath,
    );
    if (res.code === 0) {
      return ref;
    }
  }
  return null;
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
      const baseRef = await resolveBaseRef(
        deps.git,
        request.worktreePath,
        request.baseBranch,
      );
      const range = baseRef ? `${baseRef}...HEAD` : 'HEAD';

      const stat = ensureOk(
        await deps.git.run(['diff', '--stat', range], request.worktreePath),
        'diff --stat',
      );
      const nameStatus = ensureOk(
        await deps.git.run(
          ['diff', '--name-status', range],
          request.worktreePath,
        ),
        'diff --name-status',
      );
      const patchRaw = ensureOk(
        await deps.git.run(['diff', range], request.worktreePath),
        'diff',
      );

      const max = deps.config.maxPatchChars;
      const truncated = patchRaw.length > max;
      const patch = truncated ? patchRaw.slice(0, max) : patchRaw;

      const perFile = splitPatchByFile(patch);
      const fileMax = deps.config.maxFileDiffChars;
      const entries: PrDiffEntry[] = parseNameStatus(nameStatus).map((row) => {
        const filePatch = perFile.get(row.path) ?? '';
        return {
          path: row.path,
          status: row.status,
          patch:
            filePatch.length > fileMax ? filePatch.slice(0, fileMax) : filePatch,
        };
      });
      const files = entries.map((entry) => entry.path);

      return {
        baseRef,
        changedFiles: files.length,
        files,
        entries,
        stat,
        patch,
        truncated,
      };
    },
  };
}
