import type {
  IAIProvider,
  HeadlessMcpPolicy,
  InteractiveCommand,
  McpErrorScanner,
  ModelChangeScanner,
  SessionRestartScanner,
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
  buildCopilotWarmArgs,
  type Command,
} from './copilot-cmd-builder.js';
import { buildCopilotEnv } from './copilot-env-mapper.js';
import { listCopilotModels } from './copilot-model-lister.js';
import { createCopilotOutputScanner } from './copilot-output-scanner.js';
import { createCopilotModelScanner } from './copilot-model-scanner.js';
import { createCopilotMcpScanner } from './copilot-mcp-scanner.js';
import { createCopilotRestartScanner } from './copilot-restart-scanner.js';
import { ValidationError } from '../../kernel/error-types.js';
import { createCopilotMcpSupport } from './copilot-mcp-support.js';

export interface CopilotAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
  /**
   * Names of the user-configured MCP servers to disable for headless meta
   * sessions, so they never trigger a browser/OAuth sign-in on load. Read live
   * for the actual session cwd so config edits are reflected without a restart.
   */
  mcpServerNames?: (spec: SessionSpec) => readonly string[];
  resolveCommand?: (command: Command) => Command;
  mcpPolicy?: HeadlessMcpPolicy;
}

/** GitHub Copilot CLI provider. Spawns `copilot -p ...` and captures usage. */
export function createCopilotProvider(
  config: CopilotConfig,
  deps: CopilotAdapterDeps,
): IAIProvider {
  return {
    id: COPILOT_NAMESPACE,
    capabilities: { warmTransport: 'acp', planUsage: 'aic-panel' },
    buildWarmCommand(spec, extraArgs, disabledMcpServers) {
      const built = { command: config.executable,
        args: buildCopilotWarmArgs(spec, config, extraArgs, disabledMcpServers, deps.mcpPolicy ?? 'isolated') };
      return { ...(deps.resolveCommand ? deps.resolveCommand(built) : built),
        env: { ...buildCopilotEnv(spec, deps.baseEnv), STUDIO_PROVIDER_ID: COPILOT_NAMESPACE } };
    },
    mcp: createCopilotMcpSupport(config.commandProfile?.liveReloadCommand),
    async listModels() {
      return listCopilotModels(config);
    },
    startSession(spec: SessionSpec) {
      const isolated = (deps.mcpPolicy ?? 'isolated') === 'isolated';
      if (spec.kind === 'meta' && isolated && !deps.mcpServerNames) {
        throw new ValidationError('Headless MCP suppression cannot be verified. Configure trusted effective MCP sources or repair the native CLI policy before starting meta tasks.');
      }
      const built = buildCopilotCommand(
        spec,
        config,
        spec.kind === 'meta' && isolated ? deps.mcpServerNames!(spec) : [],
        deps.mcpPolicy ?? 'isolated',
      );
      const { command, args } = deps.resolveCommand ? deps.resolveCommand(built) : built;
      const env = { ...buildCopilotEnv(spec, deps.baseEnv), STUDIO_PROVIDER_ID: COPILOT_NAMESPACE };
      const handle = deps.spawner.spawn({ command, args, env, cwd: spec.cwd,
        ...(spec.noTools ? { input: spec.prompt } : {}) });
      return toRunningSession(spec.sessionId, handle);
    },
    buildInteractiveCommand(spec: SessionSpec): InteractiveCommand {
      const built = { command: config.executable, args: buildCopilotInteractiveArgs(spec, config) };
      const command = deps.resolveCommand ? deps.resolveCommand(built) : built;
      return {
        ...command,
        env: { ...buildCopilotEnv(spec, deps.baseEnv), STUDIO_PROVIDER_ID: COPILOT_NAMESPACE },
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
    createRestartScanner(): SessionRestartScanner {
      return createCopilotRestartScanner();
    },
  };
}
