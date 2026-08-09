import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Directory names skipped by the repo-wide boundary-caller scan. These hold build
 * output, dependencies or VCS metadata — never PR source — so skipping them keeps
 * the cross-project scan fast on large repos.
 */
const SKIP_SCAN_DIRS = new Set([
  '.git',
  '.vs',
  '.vscode',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'out',
  'packages',
  'TestResults',
]);

/**
 * Minimal, injectable filesystem surface the deterministic change-graph builder
 * needs to read the PR worktree. Kept tiny and behind a port so the builder,
 * project resolver and analyzers can be unit tested against an in-memory fake
 * without touching disk. All paths are repository-relative and resolved against
 * the review's worktree root.
 */
export interface ChangeGraphFs {
  /**
   * The full worktree content of a repo-relative file, or null when it can't be
   * read (e.g. a file the PR deleted, or a binary/unreadable path). Callers treat
   * null as "no declarations/references available" rather than a hard error.
   */
  readFile(worktreePath: string, repoRelativePath: string): Promise<string | null>;
  /**
   * The plain file names directly inside a repo-relative directory (no
   * recursion, directories excluded). Used to find the nearest project manifest
   * by walking up ancestors. Returns an empty list when the directory can't be
   * read.
   */
  listDir(worktreePath: string, repoRelativeDir: string): Promise<string[]>;
  /**
   * Every descendant file (repo-relative path) under a repo-relative directory,
   * recursively. Used by the bounded boundary-caller scan to find unchanged files
   * in the changed files' projects that reference a changed type. Returns an empty
   * list when the directory can't be read.
   */
  listFilesRecursive(
    worktreePath: string,
    repoRelativeDir: string,
  ): Promise<string[]>;
}

/** The real disk-backed change-graph filesystem. */
export const nodeChangeGraphFs: ChangeGraphFs = {
  async readFile(worktreePath, repoRelativePath) {
    try {
      return await readFile(join(worktreePath, repoRelativePath), 'utf8');
    } catch {
      return null;
    }
  },
  async listDir(worktreePath, repoRelativeDir) {
    try {
      const entries = await readdir(join(worktreePath, repoRelativeDir), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  async listFilesRecursive(worktreePath, repoRelativeDir) {
    const root = repoRelativeDir
      ? join(worktreePath, repoRelativeDir)
      : worktreePath;
    const found: string[] = [];
    async function walk(absDir: string, relDir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (SKIP_SCAN_DIRS.has(entry.name)) {
            continue;
          }
          await walk(join(absDir, entry.name), rel);
        } else if (entry.isFile()) {
          found.push(rel);
        }
      }
    }
    await walk(root, repoRelativeDir);
    return found;
  },
};
