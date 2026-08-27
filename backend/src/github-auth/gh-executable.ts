import { resolveExecutable } from '../terminal/executable-resolver.js';

export interface ResolveGhDeps {
  /** PATH search string. Defaults to the process PATH. */
  pathEnv?: string;
  /** Windows executable extensions (PATHEXT). Ignored off Windows. */
  pathExt?: string;
  /** Existence probe, injectable for testing. Defaults to fs.existsSync. */
  fileExists?: (candidate: string) => boolean;
  /** Platform override, injectable for testing. */
  isWindows?: boolean;
  /** Environment map used to expand well-known install dirs. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Well-known directories the GitHub CLI installs into, per platform. A desktop
 * app launched from the GUI (Start menu / Dock) frequently inherits a narrower
 * PATH than an interactive shell — one that omits `C:\Program Files\GitHub CLI`
 * (winget/MSI) or Homebrew's bin — so a bare `execFile('gh')` fails with ENOENT
 * even though `gh` works fine in a terminal. Searching these fallback dirs makes
 * sign-in resilient to that gap.
 */
function knownGhDirs(
  isWindows: boolean,
  env: NodeJS.ProcessEnv,
): string[] {
  if (isWindows) {
    const dirs: string[] = [];
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env['ProgramFiles(x86)'];
    const localAppData = env.LOCALAPPDATA;
    if (programFiles) {
      dirs.push(`${programFiles}\\GitHub CLI`);
    }
    if (programFilesX86) {
      dirs.push(`${programFilesX86}\\GitHub CLI`);
    }
    if (localAppData) {
      dirs.push(`${localAppData}\\Microsoft\\WinGet\\Links`);
      dirs.push(`${localAppData}\\Programs\\GitHub CLI`);
    }
    return dirs;
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ];
}

/**
 * Resolves the `gh` command to a concrete executable path, searching the
 * process PATH first and then well-known GitHub CLI install directories. Returns
 * an absolute path when found, or the bare `gh` command as a last resort so the
 * caller still surfaces a clear "not found" spawn error.
 */
export function resolveGhExecutable(deps: ResolveGhDeps = {}): string {
  const isWindows = deps.isWindows ?? process.platform === 'win32';
  const env = deps.env ?? process.env;
  const delimiter = isWindows ? ';' : ':';
  const basePath = deps.pathEnv ?? env.PATH ?? '';
  const augmentedPath = [basePath, ...knownGhDirs(isWindows, env)]
    .filter((part) => part.length > 0)
    .join(delimiter);
  return resolveExecutable('gh', {
    pathEnv: augmentedPath,
    pathExt: deps.pathExt,
    fileExists: deps.fileExists,
    isWindows,
  });
}
