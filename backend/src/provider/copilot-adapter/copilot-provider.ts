import type {
  IAIProvider,
  InteractiveCommand,
  SessionSpec,
} from '../provider-contract.js';
import type {
  SessionOutputScanner,
  SessionOutputScannerContext,
} from '../../session-files/session-files-contract.js';
import type { ProcessSpawner } from '../process-kernel/process-spawner.js';
import { toRunningSession } from '../process-kernel/running-session.js';
import { COPILOT_NAMESPACE, type CopilotConfig } from './config.js';
import {
  buildCopilotCommand,
  buildCopilotInteractiveArgs,
} from './copilot-cmd-builder.js';
import { buildCopilotEnv } from './copilot-env-mapper.js';
import { listCopilotModels } from './copilot-model-lister.js';
import { createCopilotOutputScanner } from './copilot-output-scanner.js';

export interface CopilotAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
}

/** GitHub Copilot CLI provider. Spawns `copilot -p ...` and captures usage. */
export function createCopilotProvider(
  config: CopilotConfig,
  deps: CopilotAdapterDeps,
): IAIProvider {
  return {
    id: COPILOT_NAMESPACE,
    async listModels() {
      return listCopilotModels(config);
    },
    startSession(spec: SessionSpec) {
      const { command, args } = buildCopilotCommand(spec, config);
      const env = buildCopilotEnv(spec, deps.baseEnv);
      const handle = deps.spawner.spawn({ command, args, env, cwd: spec.cwd });
      return toRunningSession(spec.sessionId, handle);
    },
    buildInteractiveCommand(spec: SessionSpec): InteractiveCommand {
      return {
        command: config.executable,
        args: buildCopilotInteractiveArgs(spec, config),
        env: buildCopilotEnv(spec, deps.baseEnv),
      };
    },
    createOutputScanner(ctx: SessionOutputScannerContext): SessionOutputScanner {
      return createCopilotOutputScanner(ctx);
    },
  };
}
