import { z } from 'zod';

/**
 * Configuration for the IDE-usage module, which surfaces the AI overhead spent
 * by the IDE's own headless `meta` sessions (summaries, task plans, …). Owns
 * the set of session kinds counted as IDE/assistant usage so nothing is
 * hardcoded and the existing dev-cost rollups are never affected.
 */
export const IDE_USAGE_NAMESPACE = 'ideUsage';

export const ideUsageConfigSchema = z.object({
  /** Session kinds counted as the IDE's own AI usage. */
  metaKinds: z.array(z.enum(['dev', 'meta'])).min(1),
  /** Max rows returned by the IDE metasession activity feed (what/why/credits). */
  activityLimit: z.number().int().min(1).default(50),
});

export type IdeUsageConfig = z.infer<typeof ideUsageConfigSchema>;

export const ideUsageDefaults: IdeUsageConfig = {
  metaKinds: ['meta'],
  activityLimit: 50,
};
