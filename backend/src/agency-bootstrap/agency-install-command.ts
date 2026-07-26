/**
 * Platform-specific command that installs the Microsoft `agency` CLI via the
 * official 1ES InstallTool bootstrap (https://aka.ms/InstallTool). Pure so it is
 * fully unit-testable; the actual spawning happens through a ProcessSpawner.
 */
export interface AgencyInstallPlan {
  command: string;
  args: string[];
}

/**
 * Returns the install invocation for the given platform. Windows runs the
 * PowerShell bootstrap; every other platform runs the POSIX shell bootstrap.
 */
export function agencyInstallCommand(
  platform: NodeJS.Platform,
): AgencyInstallPlan {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'iex "& { $(irm aka.ms/InstallTool.ps1)} agency"',
      ],
    };
  }
  return {
    command: 'sh',
    args: ['-c', 'curl -sSfL https://aka.ms/InstallTool.sh | sh -s agency'],
  };
}
