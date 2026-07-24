import { z } from 'zod';

/**
 * Configuration for the shared meta-session runner: the reusable "invoke the
 * CLI headlessly as AI" mechanism factored out so every AI feature (summaries,
 * task plans, …) drives it the same, config-driven way.
 */
export const META_NAMESPACE = 'meta';

export const metaConfigSchema = z.object({
  /** Provider used to run meta AI sessions. */
  providerId: z.string().min(1),
  /** Model used for meta sessions (may be 'auto'). */
  model: z.string().min(1),
  /** Candidate JSON keys to read the assistant's text from CLI JSON output. */
  responseTextKeys: z.array(z.string().min(1)).min(1),
});

export type MetaConfig = z.infer<typeof metaConfigSchema>;

export const metaDefaults: MetaConfig = {
  // Keep in sync with the enabled provider(s) in the provider config
  // (Agency by default), mirroring the summarizer defaults.
  providerId: 'agency',
  model: 'auto',
  responseTextKeys: ['response', 'text', 'content', 'message', 'result'],
};
