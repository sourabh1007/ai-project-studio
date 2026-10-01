/**
 * Platform-specific command that installs the GitHub Copilot CLI (`@github/copilot`)
 * as a global npm package, exposing the `copilot` command. Pure so it is fully
 * unit-testable; the actual spawning happens through a ProcessSpawner. Requires
 * Node.js >= 22 to already be on PATH (the desktop shell provisions it).
 */
export interface CopilotInstallPlan {
  command: string;
  args: string[];
}

const NPM_INSTALL = 'npm install -g @github/copilot';

/**
 * Returns the install invocation for the given platform. Windows runs it through
 * `cmd` (so `npm.cmd` resolves); every other platform runs it through `sh`.
 */
export function copilotInstallCommand(
  platform: NodeJS.Platform,
): CopilotInstallPlan {
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', NPM_INSTALL] };
  }
  return { command: 'sh', args: ['-c', NPM_INSTALL] };
}
