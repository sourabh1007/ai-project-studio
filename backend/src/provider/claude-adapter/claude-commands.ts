import type { HeadlessMcpPolicy, SessionSpec } from '../provider-contract.js';
import { ValidationError } from '../../kernel/error-types.js';
import type { ClaudeConfig } from './config.js';
import { optionalCommandArgsSchema } from '../command-options.js';

export interface ClaudeSessionOptions {
  /** Native session id, not a conversation name or an encoded cwd. */
  resumeSessionId?: string;
  mcpPolicy?: HeadlessMcpPolicy;
}

export function buildClaudeArgs(
  spec: SessionSpec,
  config: ClaudeConfig,
  interactive: boolean,
  options: ClaudeSessionOptions = {},
): string[] {
  const resumeId = options.resumeSessionId ?? (spec.resume ? spec.sessionId : undefined);
  const id = resumeId ?? spec.sessionId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError('Claude Code requires a UUID session id');
  }
  const args = [...optionalCommandArgsSchema.parse(config.extraArgs), ...optionalCommandArgsSchema.parse(interactive ? config.interactiveArgs : config.headlessArgs)];
  const model = spec.model === 'auto' ? config.defaultModel : spec.model;
  if (model !== 'default' && model !== 'auto') args.push('--model', model);
  args.push(resumeId === undefined ? '--session-id' : '--resume', id);
  if (interactive && spec.instructions) args.push('--append-system-prompt', spec.instructions);
  if (spec.noTools) {
    // --tools alone only disables built-ins; MCP tools must also be denied.
    args.push('--tools', '', '--disallowedTools', 'mcp__*');
  }
  if (options.mcpPolicy === 'isolated' && (spec.noTools || (!interactive && spec.kind === 'meta'))) {
    args.push('--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
  }
  if (!interactive) {
    args.push('-p', '--output-format', 'stream-json', '--verbose');
  }
  const attachments = spec.attachments ?? [];
  const prompt = attachments.length === 0
    ? spec.prompt
    : `${spec.prompt}\n\nAttached files:\n${attachments.map((path) => JSON.stringify(path)).join('\n')}`;
  // The terminal service sends interactive prompts after the TUI is ready.
  if (!interactive && !spec.noTools) args.push('--', prompt);
  const commandParts = [config.executable, ...args];
  if (commandParts.some((part) => part.includes('\0'))) {
    throw new ValidationError('Claude Code command contains a NUL character');
  }
  // Worst-case quoting doubles every character, plus quotes and separators.
  const quotedLength = commandParts.reduce((length, part) => length + 2 * part.length + 3, 0);
  if (quotedLength > config.maxCommandLineLength) {
    throw new ValidationError('Claude Code command exceeds the configured safe command-line length; reduce bootstrap instructions, prompt or extra arguments');
  }
  return args;
}

export function buildClaudeEnv(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function claudeInstallationPlan(config: ClaudeConfig, platform: string) {
  const supported = ['win32', 'darwin', 'linux'].includes(platform);
  return {
    supported,
    installCommand: supported
      ? platform === 'win32' ? config.installWindowsCommand : config.installPosixCommand
      : null,
    documentationUrl: 'https://code.claude.com/docs/en/setup',
    requiresConsent: true,
    // No implicit installation. Explicit "Install and use" consent is supported.
    automaticInstall: false,
  };
}

/** Execute only after the provider-selection flow acquires explicit consent. */
export function buildClaudeInstallCommand(config: ClaudeConfig, platform: string): {
  command: string;
  args: string[];
} | null {
  const plan = claudeInstallationPlan(config, platform);
  if (plan.installCommand === null) return null;
  return platform === 'win32'
    ? { command: config.installWindowsExecutable ?? 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', plan.installCommand] }
    : { command: config.installPosixExecutable ?? 'bash', args: ['-lc', plan.installCommand] };
}
