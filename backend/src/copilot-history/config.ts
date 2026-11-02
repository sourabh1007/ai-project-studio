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
  /**
   * Cap on bytes read backwards from the end of the live log to recover the
   * latest user message when a long reply/tool run pushed it out of the tail.
   */
  livePromptMaxScanBytes: z.number().int().positive(),
  /**
   * Upper bound on one live event-log read. A hung read (stalled sync folder,
   * network home directory) degrades that poll to store-only history instead
   * of holding the prompt-history request open.
   */
  livePromptTimeoutMs: z.number().int().positive(),
  /** Concurrent live-log scan workers (each is a bounded worker thread). */
  livePromptMaxWorkers: z.number().int().positive(),
  /** Scans allowed to wait for a worker before further reads are rejected. */
  livePromptMaxQueued: z.number().int().nonnegative(),
  /** V8 old-generation cap per scan worker, in MB. */
  livePromptWorkerMemoryMb: z.number().int().positive(),
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
  livePromptMaxScanBytes: 16777216,
  livePromptTimeoutMs: 2000,
  livePromptMaxWorkers: 2,
  livePromptMaxQueued: 8,
  livePromptWorkerMemoryMb: 128,
};
