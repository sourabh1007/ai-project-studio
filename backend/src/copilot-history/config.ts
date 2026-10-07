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
  /**
   * How recently the CLI must have recorded a usage event for an in-flight turn
   * (one the store hasn't persisted the prompt/response text for yet) to be
   * surfaced as a live "answering" row. Bounds the indicator so it self-clears
   * shortly after generation stops instead of sticking when the CLI never
   * finalises the turn.
   */
  activeAnswerWindowMs: z.number().int().positive(),
  /** Directory under {@link subdir} that holds per-session CLI event logs. */
  sessionStateDir: z.string().min(1),
  /** Event-log file name inside each session's state directory. */
  eventsFile: z.string().min(1),
  /**
   * How many bytes to read from the tail of a session's event log when
   * resolving the live in-flight prompt/response. Bounds the per-poll read so a
   * long-running session's multi-megabyte log never blocks the event loop; the
   * latest user turn virtually always lives within this window.
   */
  livePromptTailBytes: z.number().int().positive(),
});

export type CopilotHistoryConfig = z.infer<typeof copilotHistoryConfigSchema>;

export const copilotHistoryDefaults: CopilotHistoryConfig = {
  subdir: '.copilot',
  databaseFile: 'session-store.db',
  maxCheckpointsPerSession: 20,
  maxOverviewChars: 600,
  activeAnswerWindowMs: 45000,
  sessionStateDir: 'session-state',
  eventsFile: 'events.jsonl',
  livePromptTailBytes: 524288,
};
