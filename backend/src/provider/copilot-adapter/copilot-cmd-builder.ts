import type { HeadlessMcpPolicy, SessionSpec } from '../provider-contract.js';
import type { CopilotConfig } from './config.js';
import { optionalCommandArgsSchema } from '../command-options.js';

/**
 * The subset of flag toggles that shape the Copilot CLI argument vector. The
 * Agency adapter satisfies this same shape so it can reuse {@link buildCopilotArgs}.
 */
export interface CopilotFlagOptions {
  allowAllTools: boolean;
  silent: boolean;
  extraArgs: string[];
  interactiveArgs?: string[];
  headlessArgs?: string[];
  /**
   * When true, interactive sessions launch with `--screen-reader`, the CLI's
   * plain linear-output mode (no box borders/side rules). Only consumed by
   * {@link buildCopilotInteractiveArgs}; the non-interactive `-p` path ignores
   * it. Optional so callers that only build non-interactive args need not set it.
   */
  screenReader?: boolean;
}

/**
 * Builds the Copilot CLI argument vector for a session. Kept separate from the
 * command so the Agency adapter can reuse the exact same flags after its own
 * `copilot --` passthrough prefix.
 */
export function buildCopilotArgs(
  spec: SessionSpec,
  config: CopilotFlagOptions,
  disabledMcpServers: readonly string[] = [],
  mcpPolicy: HeadlessMcpPolicy = 'isolated',
): string[] {
  const args = [
    ...(spec.noTools ? [] : ['-p', spec.prompt]),
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
  if (spec.noTools) {
    // Prompt mode requires approval even with an empty tool allowlist.
    // Availability filtering exposes no tools; "*" is not a permission rule.
    args.push('--allow-all-tools', '--available-tools');
  } else if (config.allowAllTools) {
    args.push('--allow-all-tools');
  }
  // Isolated turns must suppress every MCP source before authentication can
  // start; native mode deliberately preserves the CLI's own startup policy.
  if (spec.kind === 'meta' && mcpPolicy === 'isolated') {
    args.push('--disable-builtin-mcps');
    for (const name of disabledMcpServers) {
      args.push('--disable-mcp-server', name);
    }
  }
  if (config.silent) {
    args.push('-s');
  }
  args.push(...optionalCommandArgsSchema.parse(config.extraArgs), ...optionalCommandArgsSchema.parse(config.headlessArgs ?? []));
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
  // Opt-in plain layout: the CLI's screen-reader mode drops the boxed/framed
  // TUI chrome (the vertical side rules) in favour of flat linear text.
  if (config.screenReader) {
    args.push('--screen-reader');
  }
  args.push(...optionalCommandArgsSchema.parse(config.extraArgs), ...optionalCommandArgsSchema.parse(config.interactiveArgs ?? []));
  return args;
}

/** Builds the full command (executable + args) to run a Copilot session. */
export function buildCopilotCommand(
  spec: SessionSpec,
  config: CopilotConfig,
  disabledMcpServers: readonly string[] = [],
  mcpPolicy: HeadlessMcpPolicy = 'isolated',
): Command {
  return {
    command: config.executable,
    args: buildCopilotArgs(spec, config, disabledMcpServers, mcpPolicy),
  };
}
