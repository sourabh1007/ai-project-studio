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
  /**
   * Hard ceiling (ms) for a single metasession. If the provider CLI has not
   * finished within this window it is killed and the run fails, so a stalled
   * session never hangs the caller (e.g. a PR review step) indefinitely.
   */
  timeoutMs: z.number().int().positive(),
  /**
   * The warm ACP metasession pool. When enabled, every meta AI turn leases a
   * live `copilot --acp` session from this one shared pool instead of
   * cold-spawning a CLI process per request, so the heavy startup (MCP proxies
   * + auth) is paid once and IDE-wide AI responses (PR review, review board,
   * summaries, …) are fast.
   *
   * There is deliberately a single pool: every AI feature draws from the same
   * warm capacity, so the only thing to tune is how many sessions to keep
   * ready. The cold `metaRunner` remains the automatic fallback while the pool
   * is still warming or when a warm turn fails before any prompt was
   * dispatched. Once a warm prompt may already have executed, its failure is
   * surfaced instead of retried cold.
   */
  warmPool: z.object({
    /** Whether the warm pool is used (cold path remains the fallback). */
    enabled: z.boolean(),
    /** Absolute path to the copilot executable driving the ACP process. */
    executable: z.string().min(1),
    /** Timeout (ms) for the one-time ACP `initialize` handshake. */
    initializeTimeoutMs: z.number().int().positive(),
    /** Timeout (ms) for a single warm turn (session/new + session/prompt). */
    turnTimeoutMs: z.number().int().positive(),
    /**
     * Rolling window (ms) over which peak concurrency is measured to suggest a
     * warm size. A longer window smooths spikes; a shorter one reacts faster
     * to a change in load.
     */
    demandWindowMs: z.number().int().positive(),
    /** Upper bound for a telemetry-suggested warm size. */
    maxSuggestedSize: z.number().int().positive(),
    /** How many warm sessions the pool keeps ready. */
    size: z.number().int().positive(),
  }),
});

export type MetaConfig = z.infer<typeof metaConfigSchema>;

export const metaDefaults: MetaConfig = {
  // Keep in sync with the enabled provider(s) in the provider config
  // (Agency by default), mirroring the summarizer defaults.
  providerId: 'agency',
  model: 'auto',
  responseTextKeys: ['response', 'text', 'content', 'message', 'result'],
  // 5 minutes: generous for a real AI turn, but bounded so a wedged CLI
  // surfaces as a failed step instead of an eternal "Analyzing…" spinner.
  timeoutMs: 300_000,
  warmPool: {
    // Warm by default so the IDE's AI responses are fast without a cold spawn
    // per request. Falls back to the cold path automatically while warming.
    enabled: true,
    // Resolved to the real copilot executable at startup in main.ts.
    executable: 'copilot',
    initializeTimeoutMs: 120_000,
    turnTimeoutMs: 300_000,
    // 10-minute window: long enough to capture a burst of parallel AI work
    // (PR review + review board + summaries) without over-reacting to a blip.
    demandWindowMs: 600_000,
    // Never suggest keeping more than 12 warm sessions from telemetry alone.
    maxSuggestedSize: 12,
    // One shared pool of 5 warm sessions serving every AI feature.
    size: 5,
  },
};
