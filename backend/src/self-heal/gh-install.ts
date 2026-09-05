/**
 * Pure, platform-specific plan for installing the GitHub CLI (`gh`). Kept free
 * of any process execution so it is fully unit-testable; the actual spawn lives
 * in the composition root.
 */

export interface GhInstallPlan {
  /** Whether an automated install is available on this platform. */
  supported: boolean;
  /** Executable to run (when supported). */
  command: string;
  /** Arguments for the executable. */
  args: string[];
  /** Human explanation shown in the heal log / as a fallback. */
  help: string;
}

/**
 * Build the install plan for the current platform.
 * - Windows: winget (bundled with modern Windows 10/11).
 * - macOS: Homebrew.
 * - Linux: too distro-dependent to script safely, so we return an unsupported
 *   plan that points the user at the official instructions.
 */
export function buildGhInstallPlan(platform: NodeJS.Platform): GhInstallPlan {
  if (platform === 'win32') {
    return {
      supported: true,
      command: 'winget',
      args: [
        'install',
        '--id',
        'GitHub.cli',
        '-e',
        '--source',
        'winget',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      help: 'Installing GitHub CLI via winget…',
    };
  }
  if (platform === 'darwin') {
    return {
      supported: true,
      command: 'brew',
      args: ['install', 'gh'],
      help: 'Installing GitHub CLI via Homebrew…',
    };
  }
  return {
    supported: false,
    command: '',
    args: [],
    help: 'Automatic install is not available on this platform. Install GitHub CLI from https://cli.github.com and make sure it is on your PATH.',
  };
}
