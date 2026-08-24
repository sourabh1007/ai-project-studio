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
   * Warm ACP metasession pools. When enabled, meta AI turns lease a live
   * `copilot --acp` session from a warm pool instead of cold-spawning a CLI
   * process per request, so the heavy startup (MCP proxies + auth) is paid once
   * and IDE-wide AI responses (PR review, review board, summaries, …) are fast.
   *
   * Requests are routed to the pool whose `purpose` matches; anything without a
   * matching pool uses the `general` pool. Each pool keeps `size` sessions warm.
   * The cold `metaRunner` remains the automatic fallback while a pool is still
   * warming or if a warm turn fails.
   */
  warmPool: z.object({
    /** Whether the warm pools are used (cold path remains the fallback). */
    enabled: z.boolean(),
    /** Absolute path to the copilot executable driving the ACP process. */
    executable: z.string().min(1),
    /** Timeout (ms) for the one-time ACP `initialize` handshake. */
    initializeTimeoutMs: z.number().int().positive(),
    /** Timeout (ms) for a single warm turn (session/new + session/prompt). */
    turnTimeoutMs: z.number().int().positive(),
    /**
     * The warm pools to keep ready, one per purpose. Purposes must be unique;
     * the `general` pool is the fallback for any unrouted request, so a pool
     * with that purpose must exist.
     */
    pools: z
      .array(
        z.object({
          /** Stable routing key (e.g. 'general', 'review'). */
          purpose: z.string().min(1),
          /** Number of warm sessions this pool keeps ready. */
          size: z.number().int().positive(),
        }),
      )
      .min(1)
      .superRefine((pools, ctx) => {
        const seen = new Set<string>();
        for (const pool of pools) {
          if (seen.has(pool.purpose)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate warm-pool purpose: ${pool.purpose}`,
            });
          }
          seen.add(pool.purpose);
        }
        if (!seen.has('general')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A warm pool with purpose 'general' is required.",
          });
        }
      }),
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
    // One shared pool of 5 warm sessions. Add purpose-specific pools here to
    // dedicate warm capacity to a workflow; unrouted requests use 'general'.
    pools: [{ purpose: 'general', size: 5 }],
  },
};
