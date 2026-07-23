import { z } from 'zod';

/** Configuration schema for the GitHub Copilot CLI adapter. */
export const COPILOT_NAMESPACE = 'copilot';

const modelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const copilotConfigSchema = z.object({
  enabled: z.boolean(),
  /** Executable name or absolute path of the Copilot CLI. */
  executable: z.string().min(1),
  /** Default model when a session does not specify one. */
  defaultModel: z.string().min(1),
  /** Pass --allow-all-tools (required for non-interactive runs). */
  allowAllTools: z.boolean(),
  /** Pass -s to emit only the agent response. */
  silent: z.boolean(),
  /** Extra CLI arguments appended verbatim. */
  extraArgs: z.array(z.string()),
  /** Selectable models exposed to the UI. Fully user-configurable. */
  models: z.array(modelSchema),
});

export type CopilotConfig = z.infer<typeof copilotConfigSchema>;

export const copilotDefaults: CopilotConfig = {
  // Disabled by default: only the Agency provider is active. Flip to `true`
  // (or set COPILOT_ENABLED=true) to re-enable the Copilot provider — the
  // adapter code is kept intact so re-enabling is purely a config change.
  enabled: false,
  executable: 'copilot',
  defaultModel: 'auto',
  allowAllTools: true,
  silent: true,
  extraArgs: [],
  models: [
    { id: 'auto', label: 'Auto (Copilot picks)' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  ],
};
