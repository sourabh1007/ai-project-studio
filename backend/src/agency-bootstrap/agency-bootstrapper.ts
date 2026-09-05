import type { ProcessSpawner } from '../provider/process-kernel/process-spawner.js';
import type { AgencyDetector } from './agency-detector.js';
import { agencyInstallCommand } from './agency-install-command.js';

/** Lifecycle of a background "keep agency up to date" upgrade run. */
export type AgencyUpgradePhase =
  | 'idle'
  | 'upgrading'
  | 'done'
  | 'error';

/** Current state of the auto-upgrade, surfaced to the UI via agency status. */
export interface AgencyUpgradeState {
  phase: AgencyUpgradePhase;
  /** Populated on `error`; a short human-readable reason. */
  message?: string;
}

/** Whether the agency CLI is currently installed (+ optional upgrade state). */
export interface AgencyStatus {
  installed: boolean;
  upgrade?: AgencyUpgradeState;
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
  /** Current auto-upgrade phase, for status polling by the UI. */
  upgradeState(): AgencyUpgradeState;
  /**
   * Ensures agency is installed, streaming progress via {@link onEvent}. When it
   * is already present this resolves immediately with a `done` event and no
   * install is attempted. Resolves with the final status regardless of outcome.
   */
  install(onEvent: (event: AgencyInstallEvent) => void): Promise<AgencyStatus>;
  /**
   * Re-runs the InstallTool bootstrap to pull the latest agency, regardless of
   * whether agency is already installed. This is the IDE's "keep agency current"
   * path so the CLI never has to nag for an upgrade inside a working session.
   * Tracks {@link upgradeState} across the run and resolves with the final
   * status. Safe to call in the background at startup.
   */
  upgradeToLatest(
    onEvent: (event: AgencyInstallEvent) => void,
  ): Promise<AgencyStatus>;
}

/** Creates the agency bootstrapper from injected detection + process spawning. */
export function createAgencyBootstrapper(
  deps: AgencyBootstrapDeps,
): AgencyBootstrapper {
  let upgrade: AgencyUpgradeState = { phase: 'idle' };

  /** Runs the platform install command once, streaming its output lines. */
  async function runInstall(
    onEvent: (event: AgencyInstallEvent) => void,
  ): Promise<number | null> {
    const plan = agencyInstallCommand(deps.platform);
    const handle = deps.spawner.spawn({
      command: plan.command,
      args: plan.args,
      env: deps.env,
    });
    handle.onStdoutLine((line) => onEvent({ kind: 'line', line }));
    handle.onStderrLine((line) => onEvent({ kind: 'line', line }));
    return await handle.done;
  }

  return {
    status: () => ({ installed: deps.detect(), upgrade }),

    upgradeState: () => upgrade,

    async install(onEvent) {
      if (deps.detect()) {
        onEvent({ kind: 'done' });
        return { installed: true, upgrade };
      }

      const code = await runInstall(onEvent);
      const installed = deps.detect();
      if (code === 0 && installed) {
        onEvent({ kind: 'done' });
      } else {
        onEvent({
          kind: 'error',
          message: `agency install failed (exit code ${code ?? 'null'})`,
        });
      }
      return { installed, upgrade };
    },

    async upgradeToLatest(onEvent) {
      upgrade = { phase: 'upgrading' };
      const code = await runInstall(onEvent);
      const installed = deps.detect();
      if (code === 0) {
        upgrade = { phase: 'done' };
        onEvent({ kind: 'done' });
      } else {
        const message = `agency upgrade failed (exit code ${code ?? 'null'})`;
        upgrade = { phase: 'error', message };
        onEvent({ kind: 'error', message });
      }
      return { installed, upgrade };
    },
  };
}
