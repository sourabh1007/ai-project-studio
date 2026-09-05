import type {
  IAIProvider,
  InteractiveCommand,
  McpErrorScanner,
  ModelChangeScanner,
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
import { createCopilotModelScanner } from './copilot-model-scanner.js';
import { createCopilotMcpScanner } from './copilot-mcp-scanner.js';

export interface CopilotAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
  /**
   * Names of the user-configured MCP servers to disable for headless meta
   * sessions, so they never trigger a browser/OAuth sign-in on load. Read live
   * so config edits are reflected without a restart. Omitted → none disabled.
   */
  mcpServerNames?: () => readonly string[];
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
      const { command, args } = buildCopilotCommand(
        spec,
        config,
        deps.mcpServerNames?.() ?? [],
      );
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
    createModelChangeScanner(): ModelChangeScanner {
      return createCopilotModelScanner();
    },
    createMcpErrorScanner(): McpErrorScanner {
      return createCopilotMcpScanner();
    },
  };
}
