import { z } from 'zod';

/** Configuration schema for the feature summarizer module. */
export const SUMMARIZER_NAMESPACE = 'summarizer';

export const summarizerConfigSchema = z.object({
  /** Provider used to run the meta summary session. */
  providerId: z.string().min(1),
  /** Model used for the meta session (may be 'auto'). */
  model: z.string().min(1),
  /** Session kinds whose transcripts feed the summary. */
  sourceKinds: z.array(z.enum(['dev', 'meta'])).min(1),
  /** Overall prompt template. Placeholders: {{featureName}}, {{featureDescription}}, {{sessions}}. */
  promptTemplate: z.string().min(1),
  /** Per-session block template. Placeholders: {{index}}, {{provider}}, {{model}}, {{prompt}}, {{output}}. */
  sessionTemplate: z.string().min(1),
  /** Separator inserted between rendered session blocks. */
  sessionSeparator: z.string(),
  /** Text used when a session produced no captured output. */
  emptyOutputPlaceholder: z.string().min(1),
  /** Text used when a feature has no eligible sessions. */
  noSessionsPlaceholder: z.string().min(1),
  /** Hard cap on characters of transcript output included per session. */
  maxOutputCharsPerSession: z.number().int().positive(),
  /** Candidate JSON keys to read the assistant's text from CLI JSON output. */
  responseTextKeys: z.array(z.string().min(1)).min(1),
  /** Text stored when the meta session yields no extractable summary. */
  emptySummaryPlaceholder: z.string().min(1),
});

export type SummarizerConfig = z.infer<typeof summarizerConfigSchema>;

export const summarizerDefaults: SummarizerConfig = {
  // Uses the enabled provider that runs meta summary sessions. Keep in sync
  // with the enabled provider(s) in the provider config (Agency by default).
  providerId: 'agency',
  model: 'auto',
  sourceKinds: ['dev'],
  promptTemplate: [
    'You are documenting a software feature for its team.',
    'Feature: {{featureName}}',
    'Description: {{featureDescription}}',
    '',
    'Below are the AI development sessions run for this feature.',
    'Write a concise summary in 4-5 short lines maximum, covering what was',
    'accomplished, key decisions made, and any open follow-ups. Do not invent',
    'details.',
    '',
    '{{sessions}}',
  ].join('\n'),
  sessionTemplate: [
    'Session {{index}} — provider {{provider}}, model {{model}}',
    'Prompt: {{prompt}}',
    'Output:',
    '{{output}}',
  ].join('\n'),
  sessionSeparator: '\n\n---\n\n',
  emptyOutputPlaceholder: '(no output captured)',
  noSessionsPlaceholder: '(no sessions have been run for this feature yet)',
  maxOutputCharsPerSession: 4000,
  responseTextKeys: ['response', 'text', 'content', 'message', 'result'],
  emptySummaryPlaceholder: '(the summary session produced no output)',
};
