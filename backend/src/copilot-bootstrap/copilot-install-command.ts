import { copilotBootstrapDefaults, copilotBootstrapConfigSchema, type CopilotBootstrapConfig } from './config.js';

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
  config: CopilotBootstrapConfig = copilotBootstrapDefaults,
): CopilotInstallPlan {
  const profile = copilotBootstrapConfigSchema.parse(config);
  if (platform === 'win32') {
    return { command: profile.windowsExecutable, args: ['/c', NPM_INSTALL] };
  }
  return { command: profile.posixExecutable, args: ['-c', NPM_INSTALL] };
}
