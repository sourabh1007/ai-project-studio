/** A single worktree entry parsed from `git worktree list --porcelain`. */
export interface ParsedWorktree {
  /** Absolute checkout path. */
  path: string;
  /** Short branch name, or null when the worktree is detached. */
  branch: string | null;
}

/**
 * Parses the output of `git worktree list --porcelain` into structured entries.
 * The porcelain format is a series of blocks separated by blank lines; each
 * block starts with a `worktree <path>` line and may carry a `branch
 * refs/heads/<name>` line (absent for a detached checkout).
 */
export function parseWorktreePorcelain(stdout: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      worktrees.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return worktrees;
}

/** The directory name the application checks PR worktrees out under. */
export const APP_WORKTREE_DIR = '.ai-worktrees';

/** True when a path lives inside the app's managed `.ai-worktrees` directory. */
export function isAppWorktree(path: string): boolean {
  return path.split(/[\\/]/).includes(APP_WORKTREE_DIR);
}

/**
 * Extracts the pull-request number an app worktree was created for from its
 * `<repo>-pr-<n>` directory name, or null when the name doesn't match.
 */
export function pullNumberFromPath(path: string): number | null {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const match = /-pr-(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}
