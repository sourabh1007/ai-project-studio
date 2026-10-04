import { z } from 'zod';

/** Configuration namespace for the shared-context store. */
export const CONTEXT_NAMESPACE = 'context';

export const contextConfigSchema = z.object({
  /**
   * When true, a completed dev session triggers an automatic agent-curated
   * merge of its learnings into that session's feature-scope document.
   */
  autoMergeEnabled: z.boolean(),
  /** Heading for the injected block that carries all layers. */
  sectionHeading: z.string().min(1),
  /** Per-layer labels, most-general to most-specific. */
  layerHeadings: z.object({
    workspace: z.string().min(1),
    repo: z.string().min(1),
    feature: z.string().min(1),
  }),
  /**
   * Upper bound on characters injected per layer at launch. Effectively
   * unlimited so full durable context reaches every session; the cap only
   * guards against pathological input.
   */
  maxInjectCharsPerLayer: z.number().int().positive(),
  /**
   * Upper bound on characters stored in any single document. Effectively
   * unlimited so hand-edited or file-attached context is never silently
   * truncated; the cap only guards against pathological input.
   */
  maxDocChars: z.number().int().positive(),
  /** Hard cap on transcript output fed into a merge session. */
  maxMergeInputChars: z.number().int().positive(),
  /**
   * Merge prompt template. Placeholders: {{featureName}},
   * {{featureDescription}}, {{existingContext}}, {{sessionOutput}}.
   */
  mergePromptTemplate: z.string().min(1),
  /** Text substituted for {{existingContext}} when the doc is empty. */
  emptyContextPlaceholder: z.string().min(1),
  /** Text substituted for {{sessionOutput}} when nothing was captured. */
  emptyOutputPlaceholder: z.string().min(1),
  /**
   * Short note live-pushed into running sessions when their context changes.
   * Placeholder: {{scope}}.
   */
  livePushNoteTemplate: z.string().min(1),
  /**
   * Standing prompt seeded into the editable workspace-scope context document
   * on first run (and re-applied whenever that document is blank), so every new
   * session launches with these response principles. Edit it here to change the
   * default for fresh/blank workspaces; set it empty to disable seeding. Users
   * can still override the live document in Settings → Workspace context.
   */
  defaultWorkspaceContext: z.string(),
});

export type ContextConfig = z.infer<typeof contextConfigSchema>;

export const contextDefaults: ContextConfig = {
  autoMergeEnabled: true,
  sectionHeading: '## Shared Context',
  layerHeadings: {
    workspace: '### Workspace',
    repo: '### Repository',
    feature: '### Feature',
  },
  maxInjectCharsPerLayer: 1_000_000,
  maxDocChars: 1_000_000,
  maxMergeInputChars: 4000,
  mergePromptTemplate: [
    'You maintain a durable, shared knowledge base for a software feature.',
    'It is injected into every future development session, so keep it concise,',
    'factual and reusable — durable conventions, decisions, gotchas and',
    'architecture facts, not a play-by-play of one session.',
    '',
    'Feature: {{featureName}}',
    'Description: {{featureDescription}}',
    '',
    'Existing shared context (may be empty):',
    '{{existingContext}}',
    '',
    'Latest development session output to learn from:',
    '{{sessionOutput}}',
    '',
    'Rewrite the shared context as a short markdown bullet list. Merge new,',
    'durable facts into the existing list, drop anything obsolete, and never',
    'invent details. Output only the bullet list.',
  ].join('\n'),
  emptyContextPlaceholder: '(no shared context yet)',
  emptyOutputPlaceholder: '(no output captured)',
  livePushNoteTemplate:
    'Shared {{scope}} context was updated. Re-read the "Shared Context" section before continuing.',
  defaultWorkspaceContext: [
    'Primary objective: maximize usefulness, accuracy, and clarity.',
    '',
    'Before responding:',
    '1. Determine what the user is actually trying to achieve.',
    '2. Provide the shortest response that fully solves the problem.',
    '3. Expand only when additional detail materially improves understanding or decision-making.',
    '4. Never fill knowledge gaps with assumptions.',
    '5. If something is unknown, say so directly.',
    '',
    'Response principles:',
    '- Human over robotic.',
    '- Practical over theoretical.',
    '- Precise over verbose.',
    '- Honest over confident.',
    '- Context-aware over generic.',
    '',
    'Do not:',
    '- Hallucinate facts.',
    '- Add unnecessary background.',
    '- Repeat information.',
    '- Turn simple questions into essays.',
    '- Provide superficial one-line answers to complex topics.',
  ].join('\n'),
};
