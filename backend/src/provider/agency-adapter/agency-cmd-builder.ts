import type { SessionSpec } from '../provider-contract.js';
import {
  buildCopilotArgs,
  type Command,
} from '../copilot-adapter/copilot-cmd-builder.js';
import type { AgencyConfig } from './config.js';

/**
 * Builds the command to run a session through the Agency CLI. Agency wraps the
 * same underlying Copilot CLI via `agency copilot -- <passthrough>`, so the
 * passthrough flags are produced by the shared {@link buildCopilotArgs}.
 */
export function buildAgencyCommand(
  spec: SessionSpec,
  config: AgencyConfig,
): Command {
  return {
    command: config.executable,
    args: [config.subcommand, '--', ...buildCopilotArgs(spec, config)],
  };
}
