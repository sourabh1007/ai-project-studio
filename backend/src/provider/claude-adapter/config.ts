import { z } from 'zod';
import { authLoginCommandArgsSchema, authStatusCommandArgsSchema, executableSchema, interactiveCommandSchema, optionalCommandArgsSchema, versionCommandArgsSchema } from '../command-options.js';

export const CLAUDE_NAMESPACE = 'claude';

export const claudeConfigSchema = z.object({
  enabled: z.boolean(),
  executable: executableSchema,
  defaultModel: z.string().min(1),
  models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })),
  extraArgs: optionalCommandArgsSchema,
  interactiveArgs: optionalCommandArgsSchema,
  headlessArgs: optionalCommandArgsSchema,
  /** Conservative quoted UTF-16 budget below Windows' 32767 character limit. */
  maxCommandLineLength: z.number().int().min(256).max(30_000),
  versionArgs: versionCommandArgsSchema,
  authStatusArgs: authStatusCommandArgsSchema,
  authLoginArgs: authLoginCommandArgsSchema,
  probeTimeoutMs: z.number().int().positive(),
  installTimeoutMs: z.number().int().positive(),
  usageCommand: interactiveCommandSchema,
  /** Empty means the native CLI's configuration directory; never encode cwd. */
  historyDirectory: z.string(),
  historyMaxBytes: z.number().int().positive(),
  historyMaxRecords: z.number().int().positive(),
  historyMaxSessions: z.number().int().positive(),
  historyTimeoutMs: z.number().int().positive(),
  historyWorkerMemoryMb: z.number().int().min(32),
  historyMaxEntries: z.number().int().positive(),
  installWindowsCommand: z.string().min(1),
  installPosixCommand: z.string().min(1),
  installWindowsExecutable: executableSchema.optional(),
  installPosixExecutable: executableSchema.optional(),
});

export type ClaudeConfig = z.infer<typeof claudeConfigSchema>;

export const claudeDefaults: ClaudeConfig = {
  // Registration exposes the choice; execution policy still requires selection.
  enabled: true,
  executable: 'claude',
  defaultModel: 'default',
  models: [
    { id: 'default', label: 'Default (Claude Code picks)' },
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'haiku', label: 'Claude Haiku' },
  ],
  extraArgs: [],
  interactiveArgs: [],
  headlessArgs: [],
  maxCommandLineLength: 30_000,
  versionArgs: ['--version'],
  authStatusArgs: ['auth', 'status'],
  authLoginArgs: ['auth', 'login'],
  probeTimeoutMs: 15_000,
  installTimeoutMs: 180_000,
  usageCommand: '/usage',
  historyDirectory: '',
  historyMaxBytes: 4 * 1024 * 1024,
  historyMaxRecords: 10_000,
  historyMaxSessions: 100,
  historyTimeoutMs: 15_000,
  historyWorkerMemoryMb: 64,
  historyMaxEntries: 10_000,
  installWindowsCommand: 'winget install --id Anthropic.ClaudeCode --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements',
  installPosixCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
  installWindowsExecutable: 'powershell.exe',
  installPosixExecutable: 'bash',
};
