import type { ProcessSpawner } from '../provider/process-kernel/process-spawner.js';
import type { AgencyDetector } from './agency-detector.js';
import { agencyInstallCommand } from './agency-install-command.js';

/** Whether the agency CLI is currently installed. */
export interface AgencyStatus {
  installed: boolean;
}

/** Progress events emitted while installing agency. Exactly one terminal event
 * (`done` on success, `error` on failure) follows any number of `line` events. */
export type AgencyInstallEvent =
  | { kind: 'line'; line: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export interface AgencyBootstrapDeps {
  platform: NodeJS.Platform;
  detect: AgencyDetector;
  spawner: ProcessSpawner;
  /** Environment handed to the install process (inherits the app's PATH etc.). */
  env: Record<string, string>;
}

export interface AgencyBootstrapper {
  /** Reports whether agency is installed right now. */
  status(): AgencyStatus;
  /**
   * Ensures agency is installed, streaming progress via {@link onEvent}. When it
   * is already present this resolves immediately with a `done` event and no
   * install is attempted. Resolves with the final status regardless of outcome.
   */
  install(onEvent: (event: AgencyInstallEvent) => void): Promise<AgencyStatus>;
}

/** Creates the agency bootstrapper from injected detection + process spawning. */
export function createAgencyBootstrapper(
  deps: AgencyBootstrapDeps,
): AgencyBootstrapper {
  return {
    status: () => ({ installed: deps.detect() }),

    async install(onEvent) {
      if (deps.detect()) {
        onEvent({ kind: 'done' });
        return { installed: true };
      }

      const plan = agencyInstallCommand(deps.platform);
      const handle = deps.spawner.spawn({
        command: plan.command,
        args: plan.args,
        env: deps.env,
      });
      handle.onStdoutLine((line) => onEvent({ kind: 'line', line }));
      handle.onStderrLine((line) => onEvent({ kind: 'line', line }));

      const code = await handle.done;
      const installed = deps.detect();
      if (code === 0 && installed) {
        onEvent({ kind: 'done' });
      } else {
        onEvent({
          kind: 'error',
          message: `agency install failed (exit code ${code ?? 'null'})`,
        });
      }
      return { installed };
    },
  };
}
