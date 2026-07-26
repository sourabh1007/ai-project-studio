import { posix, win32 } from 'node:path';

/**
 * Candidate absolute paths where the `agency` CLI lands after a successful
 * InstallTool bootstrap. Existence of any candidate is a reliable signal that
 * agency is installed even before it is resolvable on the current PATH (Windows
 * PATH updates only take effect in freshly-spawned shells). Pure for testing;
 * uses platform-appropriate path joins so results are host-OS independent.
 *
 * On Windows the InstallTool drops the executable into a *versioned* folder
 * (`%APPDATA%\agency\<version>\agency.exe`) and only lazily creates the
 * `CurrentVersion` junction — often after agency first runs. Probing just
 * `CurrentVersion` therefore misses a freshly-installed agency and makes the
 * first-run gate reinstall on every launch. To be robust we additionally expand
 * every immediate child folder of `%APPDATA%\agency` via the injected
 * {@link listDir}, so any versioned install counts as present.
 */
export function agencyInstallPaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string,
  listDir: (dir: string) => string[] = () => [],
): string[] {
  if (platform === 'win32') {
    const appData =
      env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : win32.join(homedir, 'AppData', 'Roaming');
    const base = win32.join(appData, 'agency');
    const names = ['CurrentVersion', ...listDir(base)];
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const name of names) {
      const candidate = win32.join(base, name, 'agency.exe');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
    return paths;
  }
  return [
    posix.join(homedir, '.local', 'bin', 'agency'),
    posix.join(homedir, '.agency', 'bin', 'agency'),
    '/usr/local/bin/agency',
  ];
}

/**
 * Returns the first candidate path that exists, or `null` when agency is not
 * installed. Used to prepend the agency executable's directory to the running
 * process PATH right after an install so subsequently-spawned terminals resolve
 * `agency` without an app restart. Pure; the existence probe is injected.
 */
export function resolveAgencyExecutable(
  paths: string[],
  pathExists: (path: string) => boolean,
): string | null {
  return paths.find((path) => pathExists(path)) ?? null;
}

