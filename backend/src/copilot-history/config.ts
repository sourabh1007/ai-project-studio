import { z } from 'zod';

/**
 * Configuration for the copilot-history module, which reads the GitHub
 * Copilot / Agency CLI's own on-disk session store (`~/.copilot/session-store.db`)
 * to surface the summaries and checkpoints the CLI already generates.
 */
export const COPILOT_HISTORY_NAMESPACE = 'copilotHistory';

export const copilotHistoryConfigSchema = z.object({
  /** Directory under the user's home that holds the CLI store. */
  subdir: z.string().min(1),
  /** SQLite file name inside {@link subdir}. */
  databaseFile: z.string().min(1),
  /** Hard cap on checkpoints returned per session (newest kept). */
  maxCheckpointsPerSession: z.number().int().positive(),
  /** Hard cap on characters of each checkpoint overview. */
  maxOverviewChars: z.number().int().positive(),
});

export type CopilotHistoryConfig = z.infer<typeof copilotHistoryConfigSchema>;

export const copilotHistoryDefaults: CopilotHistoryConfig = {
  subdir: '.copilot',
  databaseFile: 'session-store.db',
  maxCheckpointsPerSession: 20,
  maxOverviewChars: 600,
};
