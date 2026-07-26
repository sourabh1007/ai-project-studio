/**
 * Filters out filesystem events that don't represent meaningful, user-facing
 * work: dependency and build directories, VCS metadata, logs, and temp files.
 * Keeps the recorded "Files" list focused on source the session actually
 * authored rather than machine-generated churn.
 */

/** Path segments that, if present anywhere in the path, mark it as noise. */
const IGNORED_SEGMENTS = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  '.parcel-cache',
  '.gradle',
  'target',
  'bin',
  'obj',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.copilot',
]);

/** File basename suffixes that mark a path as noise. */
const IGNORED_SUFFIXES: readonly string[] = ['.log', '.tmp', '.temp', '.swp', '.lock'];

/** Exact basenames that mark a path as noise. */
const IGNORED_NAMES = new Set<string>(['.DS_Store', 'Thumbs.db']);

/** Splits a path into segments across both separator styles, dropping empties. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Whether a filesystem change at `path` should be ignored for session tracking. */
export function shouldIgnore(path: string): boolean {
  const parts = segments(path);
  if (parts.length === 0) {
    return true;
  }
  for (const part of parts) {
    if (IGNORED_SEGMENTS.has(part)) {
      return true;
    }
  }
  const name = parts[parts.length - 1];
  if (IGNORED_NAMES.has(name)) {
    return true;
  }
  // Editor swap/backup files often end with '~'.
  if (name.endsWith('~')) {
    return true;
  }
  const lower = name.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
