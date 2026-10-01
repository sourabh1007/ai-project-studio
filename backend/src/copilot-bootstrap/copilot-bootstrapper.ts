import type { ProcessSpawner } from '../provider/process-kernel/process-spawner.js';
import type { CopilotDetector } from './copilot-detector.js';
import { copilotInstallCommand } from './copilot-install-command.js';

/** Lifecycle of a background "keep Copilot up to date" upgrade run. */
export type CopilotUpgradePhase = 'idle' | 'upgrading' | 'done' | 'error';

/** Current state of the auto-upgrade, surfaced to the UI via Copilot status. */
export interface CopilotUpgradeState {
  phase: CopilotUpgradePhase;
  /** Populated on `error`; a short human-readable reason. */
  message?: string;
  /** True when the most recent successful upgrade changed the version. */
  updated?: boolean;
  /** Copilot version after a successful upgrade, when the probe resolved one. */
  version?: string | null;
  /** Copilot version before the upgrade ran, when the probe resolved one. */
  previousVersion?: string | null;
}

/** Whether the Copilot CLI is currently installed (+ optional upgrade state). */
export interface CopilotStatus {
  installed: boolean;
  upgrade?: CopilotUpgradeState;
}

/** Progress events emitted while installing Copilot. Exactly one terminal event
 * (`done` on success, `error` on failure) follows any number of `line` events. */
export type CopilotInstallEvent =
  | { kind: 'line'; line: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

export interface CopilotBootstrapDeps {
  platform: NodeJS.Platform;
  detect: CopilotDetector;
  spawner: ProcessSpawner;
  /** Environment handed to the install process (inherits the app's PATH etc.). */
  env: Record<string, string>;
  /**
   * Optional probe for the installed Copilot version. When provided,
   * {@link CopilotBootstrapper.upgradeToLatest} captures the version before and
   * after the run so it can report whether an update was actually applied.
   */
  readVersion?: () => Promise<string | null>;
}

export interface CopilotBootstrapper {
  /** Reports whether Copilot is installed right now. */
  status(): CopilotStatus;
  /** Current auto-upgrade phase, for status polling by the UI. */
  upgradeState(): CopilotUpgradeState;
  /**
   * Ensures Copilot is installed, streaming progress via {@link onEvent}. When it
   * is already present this resolves immediately with a `done` event and no
   * install is attempted. Resolves with the final status regardless of outcome.
   */
  install(onEvent: (event: CopilotInstallEvent) => void): Promise<CopilotStatus>;
  /**
   * Re-runs `npm install -g @github/copilot` to pull the latest Copilot CLI,
   * regardless of whether it is already installed. Tracks {@link upgradeState}
   * across the run and resolves with the final status. Safe to call in the
   * background at startup.
   */
  upgradeToLatest(
    onEvent: (event: CopilotInstallEvent) => void,
  ): Promise<CopilotStatus>;
}

/** Creates the Copilot bootstrapper from injected detection + process spawning. */
export function createCopilotBootstrapper(
  deps: CopilotBootstrapDeps,
): CopilotBootstrapper {
  let upgrade: CopilotUpgradeState = { phase: 'idle' };

  async function runInstall(
    onEvent: (event: CopilotInstallEvent) => void,
  ): Promise<number | null> {
    const plan = copilotInstallCommand(deps.platform);
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
          message: `copilot install failed (exit code ${code ?? 'null'})`,
        });
      }
      return { installed, upgrade };
    },

    async upgradeToLatest(onEvent) {
      const previousVersion = deps.readVersion ? await deps.readVersion() : null;
      upgrade = { phase: 'upgrading' };
      const code = await runInstall(onEvent);
      const installed = deps.detect();
      if (code === 0) {
        if (deps.readVersion) {
          const version = await deps.readVersion();
          const updated =
            version != null &&
            previousVersion != null &&
            version !== previousVersion;
          upgrade = { phase: 'done', updated, version, previousVersion };
        } else {
          upgrade = { phase: 'done' };
        }
        onEvent({ kind: 'done' });
      } else {
        const message = `copilot upgrade failed (exit code ${code ?? 'null'})`;
        upgrade = { phase: 'error', message };
        onEvent({ kind: 'error', message });
      }
      return { installed, upgrade };
    },
  };
}
