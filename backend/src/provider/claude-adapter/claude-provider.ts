import type { Logger } from '../../kernel/logger.js';
import { ProviderError } from '../../kernel/error-types.js';
import type { HeadlessMcpPolicy, IAIProvider, ImportableSession, SessionSpec } from '../provider-contract.js';
import type { ProcessSpawner } from '../process-kernel/process-spawner.js';
import { toRunningSession } from '../process-kernel/running-session.js';
import { CLAUDE_NAMESPACE, type ClaudeConfig } from './config.js';
import { buildClaudeArgs, buildClaudeEnv, type ClaudeSessionOptions } from './claude-commands.js';
import { parseClaudeLine } from './claude-protocol.js';
import { normalizeClaudeSession } from './claude-session.js';

export interface ClaudeAdapterDeps {
  spawner: ProcessSpawner;
  baseEnv: Record<string, string | undefined>;
  logger: Logger;
  /** Parent-owned version/policy probes must complete before any CLI execution. */
  assertReady?: () => void;
  waitUntilReady?: () => Promise<void>;
  /** Verified by the native `auth status` probe, not by reading credentials. */
  authMethod?: () => string | null;
  sessionOptions?: (spec: SessionSpec) => ClaudeSessionOptions;
  mcpPolicy?: HeadlessMcpPolicy;
  /** Cache only; injected IO/worker refresh happens outside request handling. */
  listImportableSessions?: () => ImportableSession[];
}

export const CLAUDE_AUTH_NOTICE =
  'Native mode delegates sign-in to the unmodified Claude Code CLI. Isolated programmatic runs require your own Anthropic API key or supported cloud provider credentials. Studio never collects, stores or intermediates Claude.ai credentials or session tokens.';

export function assertClaudeHeadlessAuth(
  env: Record<string, string | undefined>,
  authMethod: string | null,
): void {
  const cloud = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some((key) => env[key] === '1');
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || cloud ||
    ['api_key', 'api_key_helper', 'third_party'].includes(authMethod ?? '')) return;
  throw new ProviderError(`Unsupported Claude Code headless authentication. ${CLAUDE_AUTH_NOTICE}`);
}

export interface ClaudeVersionCapabilities {
  version: string | null;
  status: 'supported' | 'unsupported' | 'unknown';
  nativeInteractive: boolean;
  streamJson: boolean;
  quota: 'unavailable';
}

/** Conservatively support the documented v2 native CLI, not arbitrary output. */
export function claudeVersionCapabilities(output: string): ClaudeVersionCapabilities {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/.exec(output.trim());
  const version = match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  const supported = match !== null && Number(match[1]) === 2;
  return {
    version,
    status: match === null ? 'unknown' : supported ? 'supported' : 'unsupported',
    nativeInteractive: supported,
    streamJson: supported,
    quota: 'unavailable',
  };
}

export function parseClaudeAuthStatus(line: string) {
  const record = parseClaudeLine(line);
  if (!record || typeof record.loggedIn !== 'boolean' || typeof record.authMethod !== 'string') {
    return { authenticated: false, method: null, headlessSupported: false };
  }
  return {
    authenticated: record.loggedIn,
    method: record.authMethod,
    headlessSupported: record.loggedIn,
  };
}

export function claudeProbeCommands(config: ClaudeConfig) {
  return {
    version: { command: config.executable, args: [...config.versionArgs] },
    authStatus: { command: config.executable, args: [...config.authStatusArgs] },
    authLogin: { command: config.executable, args: [...config.authLoginArgs] },
    usage: { command: config.usageCommand, availability: 'unavailable' },
  };
}

export function createClaudeProvider(config: ClaudeConfig, deps: ClaudeAdapterDeps): IAIProvider {
  return {
    id: CLAUDE_NAMESPACE,
    capabilities: { interactiveBootstrap: 'command' },
    prepareInteractiveSession: deps.waitUntilReady,
    async listModels() {
      return config.models.map((model) => ({ ...model }));
    },
    startSession(spec) {
      deps.assertReady?.();
      if (deps.mcpPolicy === 'isolated') assertClaudeHeadlessAuth(deps.baseEnv, deps.authMethod?.() ?? null);
      const args = buildClaudeArgs(spec, config, false, {
        ...deps.sessionOptions?.(spec), mcpPolicy: deps.mcpPolicy ?? 'native',
      });
      const handle = normalizeClaudeSession(deps.spawner.spawn({
        command: config.executable,
        args,
        env: buildClaudeEnv(deps.baseEnv),
        cwd: spec.cwd,
        ...(spec.noTools ? { input: spec.prompt } : { stdin: 'ignore' as const }),
      }));
      handle.onExit((code) => {
        if (code !== 0) {
          // Never log CLI output, argv or environment: they may contain secrets.
          deps.logger.error('Claude Code session failed', { sessionId: spec.sessionId, exitCode: code });
        }
      });
      return toRunningSession(spec.sessionId, handle);
    },
    buildInteractiveCommand(spec) {
      deps.assertReady?.();
      return {
        command: config.executable,
        args: buildClaudeArgs(spec, config, true, deps.sessionOptions?.(spec)),
        env: buildClaudeEnv(deps.baseEnv),
      };
    },
    listImportableSessions: deps.listImportableSessions,
  };
}
