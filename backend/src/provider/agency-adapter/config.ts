import { z } from 'zod';

/** Configuration schema for the Agency CLI adapter. */
export const AGENCY_NAMESPACE = 'agency';

const modelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const agencyConfigSchema = z.object({
  enabled: z.boolean(),
  /** Executable name or absolute path of the Agency CLI. */
  executable: z.string().min(1),
  /** Wrapped provider subcommand; Agency forwards to the Copilot CLI. */
  subcommand: z.string().min(1),
  /** Default model when a session does not specify one. */
  defaultModel: z.string().min(1),
  /** Pass --allow-all-tools to the wrapped Copilot CLI. */
  allowAllTools: z.boolean(),
  /** Pass -s to the wrapped Copilot CLI. */
  silent: z.boolean(),
  /** Extra CLI arguments appended verbatim to the passthrough. */
  extraArgs: z.array(z.string()),
  /** Pass --screen-reader to interactive sessions for plain, unboxed output. */
  screenReader: z
    .boolean()
    .describe(
      'Plain session layout: launch interactive terminals in the CLI\u2019s ' +
        'screen-reader mode, which renders output as flat linear text with no ' +
        'box borders or side rules. Off by default. Also changes streaming/' +
        'spinner rendering throughout. Applies to sessions started after a restart.',
    ),
  /** Selectable models exposed to the UI. Fully user-configurable. */
  models: z.array(modelSchema),
});

export type AgencyConfig = z.infer<typeof agencyConfigSchema>;

export const agencyDefaults: AgencyConfig = {
  enabled: true,
  executable: 'agency',
  subcommand: 'copilot',
  defaultModel: 'auto',
  allowAllTools: true,
  silent: true,
  extraArgs: [],
  screenReader: false,
  models: [
    { id: 'auto', label: 'Auto (Agency picks)' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
};
