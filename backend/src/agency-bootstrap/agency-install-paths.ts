import { posix, win32 } from 'node:path';

/**
 * Candidate absolute paths where the `agency` CLI lands after a successful
 * InstallTool bootstrap. Existence of any candidate is a reliable signal that
 * agency is installed even before it is resolvable on the current PATH (Windows
 * PATH updates only take effect in freshly-spawned shells). Pure for testing;
 * uses platform-appropriate path joins so results are host-OS independent.
 */
export function agencyInstallPaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string,
): string[] {
  if (platform === 'win32') {
    const appData =
      env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : win32.join(homedir, 'AppData', 'Roaming');
    return [win32.join(appData, 'agency', 'CurrentVersion', 'agency.exe')];
  }
  return [
    posix.join(homedir, '.local', 'bin', 'agency'),
    posix.join(homedir, '.agency', 'bin', 'agency'),
    '/usr/local/bin/agency',
  ];
}

