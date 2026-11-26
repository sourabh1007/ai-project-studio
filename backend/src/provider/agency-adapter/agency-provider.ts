import type {
  IAIProvider,
  HeadlessMcpPolicy,
  ImportableSession,
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
import type { CliSessionStore } from '../cli-store/cli-session-store.js';
import { toRunningSession } from '../process-kernel/running-session.js';
import { AGENCY_NAMESPACE, type AgencyConfig } from './config.js';
import { buildAgencyCommand } from './agency-cmd-builder.js';
import { buildAgencyEnv } from './agency-env-mapper.js';
import { listAgencyModels } from './agency-model-lister.js';
import { buildCopilotInteractiveArgs, buildCopilotWarmArgs } from '../copilot-adapter/copilot-cmd-builder.js';
import { createCopilotOutputScanner } from '../copilot-adapter/copilot-output-scanner.js';
import { createCopilotModelScanner } from '../copilot-adapter/copilot-model-scanner.js';
import { createCopilotMcpScanner } from '../copilot-adapter/copilot-mcp-scanner.js';
import { createCopilotRestartScanner } from '../copilot-adapter/copilot-restart-scanner.js';
import { createCopilotMcpSupport } from '../copilot-adapter/copilot-mcp-support.js';
import { ValidationError } from '../../kernel/error-types.js';

export interface AgencyAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
  /** Source of past CLI sessions available to import into a feature. */
  importStore: CliSessionStore;
  mcpPolicy?: HeadlessMcpPolicy;
  nativeCopilot?: () => string | null;
}

/** Agency CLI provider. Wraps the Copilot CLI via `agency copilot -- ...`. */
export function createAgencyProvider(
  config: AgencyConfig,
  deps: AgencyAdapterDeps,
): IAIProvider {
  return {
    id: AGENCY_NAMESPACE,
    capabilities: { warmTransport: 'acp', planUsage: 'aic-panel' },
    buildWarmCommand(spec, extraArgs, disabledMcpServers) {
      if (deps.mcpPolicy === 'isolated') {
        throw new ValidationError('Agency warm workers cannot verify zero-MCP isolation. Select native MCP policy and restart; native authentication and administrator policies remain enforced.');
      }
      return { command: config.executable,
        args: [config.subcommand, '--', ...buildCopilotWarmArgs(spec, config, extraArgs, disabledMcpServers, 'native')],
        env: { ...buildAgencyEnv(spec, deps.baseEnv, deps.nativeCopilot?.()), STUDIO_PROVIDER_ID: AGENCY_NAMESPACE } };
    },
    async listModels() {
      return listAgencyModels(config);
    },
    startSession(spec: SessionSpec) {
      if (spec.kind === 'meta' && deps.mcpPolicy === 'isolated') {
        throw new ValidationError('Agency cannot guarantee zero-MCP startup in isolated mode. Choose native MCP policy in Settings for normal Agency execution, or use a provider with verifiable isolation. Native administrator and trust policies remain enforced.');
      }
      const { command, args } = buildAgencyCommand(spec, config, [], deps.mcpPolicy ?? 'native');
      const env = { ...buildAgencyEnv(spec, deps.baseEnv, deps.nativeCopilot?.()), STUDIO_PROVIDER_ID: AGENCY_NAMESPACE };
      const handle = deps.spawner.spawn({ command, args, env, cwd: spec.cwd,
        ...(spec.noTools ? { input: spec.prompt } : {}) });
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
        env: { ...buildAgencyEnv(spec, deps.baseEnv, deps.nativeCopilot?.()), STUDIO_PROVIDER_ID: AGENCY_NAMESPACE },
      };
    },
    createOutputScanner(ctx: SessionOutputScannerContext): SessionOutputScanner {
      // Agency forwards to the same Copilot CLI, so it announces file ops the
      // same way; reuse Copilot's scanner rather than duplicating the patterns.
      return createCopilotOutputScanner(ctx);
    },
    createModelChangeScanner(): ModelChangeScanner {
      // Same Copilot CLI underneath, so the "Model changed …" line is identical;
      // reuse Copilot's model scanner.
      return createCopilotModelScanner();
    },
    createMcpErrorScanner(): McpErrorScanner {
      // Same Copilot CLI underneath, so MCP connection failures are announced
      // identically; reuse Copilot's MCP-error scanner.
      return createCopilotMcpScanner();
    },
    createRestartScanner(): SessionRestartScanner {
      // Agency relays the same Copilot CLI "session needs to restart" line
      // (e.g. when an MCP server is reconfigured), so reuse Copilot's scanner.
      return createCopilotRestartScanner();
    },
    listImportableSessions(): ImportableSession[] {
      return deps.importStore.listImportable();
    },
    // Agency runs the Copilot CLI underneath, so it exposes the same
    // mcp-config.json; reuse Copilot's MCP support.
    mcp: createCopilotMcpSupport(config.commandProfile?.liveReloadCommand),
  };
}
