/**
 * Curated catalog of every prompt and command the IDE sends to AI providers /
 * CLIs, grouped into sections that mirror the product's UI areas. Editable
 * entries map to a `<namespace>.<key>` config field (persisted through the
 * existing `/config` override API); read-only entries document a command or a
 * hardcoded prompt the UI cannot yet tune.
 *
 * This is presentation metadata only — the source of truth for values is the
 * backend config registry, read live via `getConfig()`.
 */

/** One editable prompt/command field backed by a config namespace + key. */
export interface PromptCatalogField {
  /** Config namespace, e.g. `reviewBoard`. */
  namespace: string;
  /** Config key within the namespace, e.g. `perspectivePromptTemplate`. */
  key: string;
  /** Human label for the field. */
  label: string;
  /** One-line explanation of what this prompt/command drives. */
  description: string;
  /** Placeholders the template supports (shown as editing hints). */
  placeholders?: string[];
}

/** A read-only prompt/command the IDE uses that isn't user-editable yet. */
export interface PromptCatalogReadOnly {
  /** Stable id used for the anchor. */
  id: string;
  label: string;
  description: string;
  /** The command/prompt text to display verbatim. */
  text: string;
  /** Whether this documents a CLI command (vs. a prompt). */
  command?: boolean;
}

export interface PromptCatalogSection {
  id: string;
  title: string;
  description: string;
  fields: PromptCatalogField[];
  readOnly?: PromptCatalogReadOnly[];
}

/**
 * The sections rendered in Settings → Prompts & Commands, ordered to mirror how
 * a reviewer meets them in the UI. Agent-owned prompts (e.g. the Review Board's
 * perspective templates) are intentionally excluded here — those live in each
 * agent's own settings, reached from the Agents view.
 */
export const PROMPT_CATALOG: PromptCatalogSection[] = [
  {
    id: 'task-plans',
    title: 'Task Plans',
    description: 'The prompt that breaks a feature into an ordered task plan.',
    fields: [
      {
        namespace: 'featureTasks',
        key: 'promptTemplate',
        label: 'Feature task-plan generation',
        description:
          'Splits a feature into at most N concrete, ordered sub-tasks as ' +
          'strict JSON.',
        placeholders: ['featureName', 'featureDescription', 'maxTasks'],
      },
    ],
  },
  {
    id: 'skills',
    title: 'Skills',
    description:
      'How active skills are injected into a session and how their removal is ' +
      'announced to a live session.',
    fields: [
      {
        namespace: 'skills',
        key: 'injectionHeader',
        label: 'Skill injection header',
        description: 'Header prefixed to the active-skill instruction block.',
      },
      {
        namespace: 'skills',
        key: 'skillTemplate',
        label: 'Per-skill rendering',
        description: 'How one instruction skill is rendered into the block.',
        placeholders: ['name', 'instructions'],
      },
      {
        namespace: 'skills',
        key: 'removalHeader',
        label: 'Skill removal header',
        description: 'Header used when telling a session a skill was removed.',
      },
      {
        namespace: 'skills',
        key: 'instructionRemovalTemplate',
        label: 'Instruction-skill removal',
        description: 'Tells a live session to stop following a removed skill.',
      },
      {
        namespace: 'skills',
        key: 'taskPlanRemovalTemplate',
        label: 'Task-plan-skill removal',
        description: 'Tells a live session to cancel a removed task-plan skill.',
      },
    ],
  },
  {
    id: 'summaries',
    title: 'Summaries',
    description:
      'Prompts that summarise development sessions into a feature summary.',
    fields: [
      {
        namespace: 'summarizer',
        key: 'promptTemplate',
        label: 'Feature / session summary',
        description:
          'Summarises collected sessions into accomplishments, decisions and ' +
          'follow-ups.',
      },
      {
        namespace: 'summarizer',
        key: 'sessionTemplate',
        label: 'Per-session rendering',
        description:
          'How one session (provider, prompt, transcript) is embedded into ' +
          'the summary prompt.',
      },
    ],
  },
  {
    id: 'repository-analysis',
    title: 'Repository Analysis',
    description:
      'Prompts that derive read-only repository context (single-pass, chunked ' +
      'and synthesis passes for large repositories).',
    fields: [
      {
        namespace: 'repositoryContext',
        key: 'analysisPromptTemplate',
        label: 'Single-pass analysis',
        description: 'Bounded, read-only analysis of a small repository.',
      },
      {
        namespace: 'repositoryContext',
        key: 'chunkPromptTemplate',
        label: 'Large-repository chunk',
        description: 'Analyses one labelled chunk of repository evidence.',
      },
      {
        namespace: 'repositoryContext',
        key: 'synthesisPromptTemplate',
        label: 'Chunk synthesis',
        description: 'Synthesises chunk summaries into final repository context.',
      },
    ],
  },
  {
    id: 'cli-commands',
    title: 'Provider CLI Commands',
    description:
      'The command lines the IDE builds to drive the underlying AI CLIs. These ' +
      'are assembled from provider settings (executable, tools, extra args) on ' +
      'the Configuration tab and are shown here read-only for transparency.',
    fields: [],
    readOnly: [
      {
        id: 'cli-copilot-headless',
        label: 'Copilot — headless session',
        command: true,
        description:
          'Non-interactive prompt-to-JSON run used for every analysis turn.',
        text: [
          'copilot -p <prompt>',
          '        --model <model>',
          '        --session-id <uuid>',
          '        --output-format json',
          '        --no-color',
          '        [--attachment <path>]…',
          '        [--allow-all-tools | --available-tools]',
          '        [--disable-builtin-mcps]        (meta sessions)',
          '        [--disable-mcp-server <name>]…',
          '        [-s]                             (silent)',
          '        [<extraArgs>…]',
        ].join('\n'),
      },
      {
        id: 'cli-copilot-interactive',
        label: 'Copilot — interactive session',
        command: true,
        description:
          'Starts the native interactive Copilot TUI (no -p / JSON output).',
        text: [
          'copilot --model <model>',
          '        --session-id <uuid>',
          '        [--attachment <path>]…',
          '        [--allow-all-tools]',
          '        [<extraArgs>…]',
        ].join('\n'),
      },
      {
        id: 'cli-agency',
        label: 'Agency — Copilot passthrough',
        command: true,
        description:
          'Runs the same Copilot session through the Agency CLI wrapper.',
        text: '<agency> <subcommand> -- <copilot headless args…>',
      },
    ],
  },
  {
    id: 'settings-assistant',
    title: 'Settings Assistant',
    description:
      'The grounded prompt behind the “ask the assistant” helper on the ' +
      'Configuration tab. Shown read-only.',
    fields: [],
    readOnly: [
      {
        id: 'settings-assistant-prompt',
        label: 'Settings assistant',
        description:
          'Answers a question about a setting using only its supplied ' +
          'metadata; recommends a value and never invents settings.',
        text: [
          'You are a configuration assistant for AI Project Studio.',
          'Using ONLY the setting metadata provided, answer the user’s',
          'question, explain the trade-offs, and recommend a value.',
          'Never invent settings that were not provided.',
        ].join('\n'),
      },
    ],
  },
];
