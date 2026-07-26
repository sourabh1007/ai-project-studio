import type {
  IAIProvider,
  ImportableSession,
  InteractiveCommand,
  SessionSpec,
} from '../provider-contract.js';
import type {
  SessionOutputScanner,
  SessionOutputScannerContext,
} from '../../session-files/session-files-contract.js';
import type { ProcessSpawner } from '../process-kernel/process-spawner.js';
import type { CliSessionStore } from '../cli-store/cli-session-store.js';
import { toRunningSession } from '../process-kernel/running-session.js';
import { AGENCY_NAMESPACE, type AgencyConfig } from './config.js';
import { buildAgencyCommand } from './agency-cmd-builder.js';
import { buildAgencyEnv } from './agency-env-mapper.js';
import { listAgencyModels } from './agency-model-lister.js';
import { buildCopilotInteractiveArgs } from '../copilot-adapter/copilot-cmd-builder.js';
import { createCopilotOutputScanner } from '../copilot-adapter/copilot-output-scanner.js';

export interface AgencyAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
  /** Source of past CLI sessions available to import into a feature. */
  importStore: CliSessionStore;
}

/** Agency CLI provider. Wraps the Copilot CLI via `agency copilot -- ...`. */
export function createAgencyProvider(
  config: AgencyConfig,
  deps: AgencyAdapterDeps,
): IAIProvider {
  return {
    id: AGENCY_NAMESPACE,
    async listModels() {
      return listAgencyModels(config);
    },
    startSession(spec: SessionSpec) {
      const { command, args } = buildAgencyCommand(spec, config);
      const env = buildAgencyEnv(spec, deps.baseEnv);
      const handle = deps.spawner.spawn({ command, args, env, cwd: spec.cwd });
      return toRunningSession(spec.sessionId, handle);
    },
    buildInteractiveCommand(spec: SessionSpec): InteractiveCommand {
      return {
        command: config.executable,
        args: [
          config.subcommand,
          '--',
          ...buildCopilotInteractiveArgs(spec, config),
        ],
        env: buildAgencyEnv(spec, deps.baseEnv),
      };
    },
    createOutputScanner(ctx: SessionOutputScannerContext): SessionOutputScanner {
      // Agency forwards to the same Copilot CLI, so it announces file ops the
      // same way; reuse Copilot's scanner rather than duplicating the patterns.
      return createCopilotOutputScanner(ctx);
    },
    listImportableSessions(): ImportableSession[] {
      return deps.importStore.listImportable();
    },
  };
}
