import { z } from 'zod';
import { copilotCommandProfile, providerCommandProfileSchema } from '../provider-command-profile.js';
import { executableSchema, optionalCommandArgsSchema } from '../command-options.js';

/** Configuration schema for the GitHub Copilot CLI adapter. */
export const COPILOT_NAMESPACE = 'copilot';

const modelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const copilotConfigSchema = z.object({
  enabled: z.boolean(),
  /** Executable name or absolute path of the Copilot CLI. */
  executable: executableSchema,
  /** Default model when a session does not specify one. */
  defaultModel: z.string().min(1),
  /** Pass --allow-all-tools (required for non-interactive runs). */
  allowAllTools: z.boolean(),
  /** Pass -s to emit only the agent response. */
  silent: z.boolean(),
  /** Extra CLI arguments appended verbatim. */
  extraArgs: optionalCommandArgsSchema,
  interactiveArgs: optionalCommandArgsSchema.optional(),
  headlessArgs: optionalCommandArgsSchema.optional(),
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
  commandProfile: providerCommandProfileSchema.optional(),
});

export type CopilotConfig = z.infer<typeof copilotConfigSchema>;

export const copilotDefaults: CopilotConfig = {
  // Registers an option for explicit CLI selection; it does not activate or install it.
  enabled: true,
  executable: 'copilot',
  defaultModel: 'auto',
  allowAllTools: true,
  silent: true,
  extraArgs: [],
  interactiveArgs: [],
  headlessArgs: [],
  screenReader: false,
  commandProfile: copilotCommandProfile,
  models: [
    { id: 'auto', label: 'Auto (Copilot picks)' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  ],
};
