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
  /** Hard cap on characters injected per layer at launch (keeps prompts small). */
  maxInjectCharsPerLayer: z.number().int().positive(),
  /** Hard cap on characters stored in any single document. */
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
  maxInjectCharsPerLayer: 2000,
  maxDocChars: 4000,
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
};
