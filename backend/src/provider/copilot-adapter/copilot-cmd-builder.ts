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
  disabledMcpServers: readonly string[] = [],
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
  if (spec.noTools) {
    // Restrict the agent to zero tools: a pure prompt→text completion with no
    // agentic tool loops (fast, and it can never wedge waiting on a tool).
    // Takes precedence over the provider's blanket allow-all-tools default.
    args.push('--available-tools');
  } else if (config.allowAllTools) {
    args.push('--allow-all-tools');
  }
  // Headless meta sessions (summaries, PR review, repo context, monitors,
  // automations) run with no interactive TTY, so an MCP server that tries a
  // browser/OAuth sign-in on load can never complete it — it just pops a
  // browser (once per server, so N servers = N windows) and stalls the run.
  // Suppress MCP entirely for these sessions: disable the built-in server and
  // every user-configured one so the CLI never initializes an MCP connection.
  if (spec.kind === 'meta') {
    args.push('--disable-builtin-mcps');
    for (const name of disabledMcpServers) {
      args.push('--disable-mcp-server', name);
    }
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
  disabledMcpServers: readonly string[] = [],
): Command {
  return {
    command: config.executable,
    args: buildCopilotArgs(spec, config, disabledMcpServers),
  };
}
