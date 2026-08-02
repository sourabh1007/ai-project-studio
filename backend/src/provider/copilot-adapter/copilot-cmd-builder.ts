import type { SessionSpec } from '../provider-contract.js';
import type { CopilotConfig } from './config.js';

/**
 * The subset of flag toggles that shape the Copilot CLI argument vector. The
 * Agency adapter satisfies this same shape so it can reuse {@link buildCopilotArgs}.
 */
export interface CopilotFlagOptions {
  allowAllTools: boolean;
  silent: boolean;
  extraArgs: string[];
}

/**
 * Builds the Copilot CLI argument vector for a session. Kept separate from the
 * command so the Agency adapter can reuse the exact same flags after its own
 * `copilot --` passthrough prefix.
 */
export function buildCopilotArgs(
  spec: SessionSpec,
  config: CopilotFlagOptions,
): string[] {
  const args = [
    '-p',
    spec.prompt,
    '--model',
    spec.model,
    '--session-id',
    spec.sessionId,
    '--output-format',
    'json',
    '--no-color',
  ];
  for (const attachment of spec.attachments ?? []) {
    args.push('--attachment', attachment);
  }
  if (config.allowAllTools) {
    args.push('--allow-all-tools');
  }
  if (config.silent) {
    args.push('-s');
  }
  args.push(...config.extraArgs);
  return args;
}

export interface Command {
  command: string;
  args: string[];
}

/**
 * Builds the Copilot CLI argument vector for an *interactive* session: the
 * native chat TUI (no `-p`, no JSON output, colours kept). Usage is still
 * tagged via the OTel env, and `--session-id` ties the run to our Session.
 */
export function buildCopilotInteractiveArgs(
  spec: SessionSpec,
  config: CopilotFlagOptions,
): string[] {
  const args = ['--model', spec.model, '--session-id', spec.sessionId];
  for (const attachment of spec.attachments ?? []) {
    args.push('--attachment', attachment);
  }
  if (config.allowAllTools) {
    args.push('--allow-all-tools');
  }
  args.push(...config.extraArgs);
  return args;
}

/** Builds the full command (executable + args) to run a Copilot session. */
export function buildCopilotCommand(
  spec: SessionSpec,
  config: CopilotConfig,
): Command {
  return {
    command: config.executable,
    args: buildCopilotArgs(spec, config),
  };
}
