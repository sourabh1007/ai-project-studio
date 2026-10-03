import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface ResolveExecutableDeps {
  /** PATH search string. Defaults to the process PATH. */
  pathEnv?: string;
  /** Windows executable extensions (PATHEXT). Ignored off Windows. */
  pathExt?: string;
  /** Existence probe, injectable for testing. Defaults to fs.existsSync. */
  fileExists?: (candidate: string) => boolean;
  /** Platform override, injectable for testing. */
  isWindows?: boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Resolves a command name to a concrete executable path. Windows ConPTY (via
 * node-pty) does not search PATH or apply PATHEXT the way `child_process` does,
 * so a bare name like `copilot` must be resolved to `C:\...\copilot.exe` before
 * it can be spawned. Pure and fully testable; falls back to the original
 * command when nothing matches so the caller surfaces a clear spawn error.
 */
export function resolveExecutable(
  command: string,
  deps: ResolveExecutableDeps = {},
): string {
  const fileExists = deps.fileExists ?? existsSync;
  const isWindows = deps.isWindows ?? process.platform === 'win32';
  const pathApi = isWindows ? win32 : posix;
  const { delimiter, isAbsolute, join, sep } = pathApi;
  const exts = isWindows
    ? (deps.pathExt ?? process.env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(';')
        .filter((ext) => ext.length > 0)
    : [];

  // On Windows a bare command is launched through PATHEXT, so an executable
  // variant (`copilot.CMD`, `copilot.EXE`) must win over a same-named
  // extensionless file. npm global installs drop a POSIX shell script named
  // `copilot` next to `copilot.cmd`; ConPTY/node-pty cannot spawn the
  // extensionless script, so trying the extension variants first is what makes
  // the CLI actually open. The bare base stays as a last resort. Off Windows
  // `exts` is empty, so this is just `[base]`.
  const withExts = (base: string): string[] =>
    isWindows ? [...exts.map((ext) => base + ext), base] : [base];

  if (isAbsolute(command) || command.includes(sep) || command.includes('/')) {
    return withExts(command).find(fileExists) ?? command;
  }

  const dirs = (deps.pathEnv ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const match = withExts(join(dir, command)).find(fileExists);
    if (match) {
      return match;
    }
  }
  return command;
}
